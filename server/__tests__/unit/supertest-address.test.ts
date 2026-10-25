import http from "node:http";
import os from "node:os";
import type { AddressInfo, ListenOptions } from "node:net";
import request from "supertest";

const useIPv6Loopback =
  process.platform === "darwin" &&
  Object.values(os.networkInterfaces())
    .flat()
    .some((address) => address?.internal && address.address === "::1");
// This collision is macOS-specific and needs an available IPv6 loopback.
const testIPv6Collision = useIPv6Loopback ? test : test.skip;
const servers: http.Server[] = [];

async function listen(server: http.Server, options: ListenOptions) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, resolve);
  });
  return server.address() as AddressInfo;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

testIPv6Collision(
  "an IPv6 server is reached even when an IPv4 server owns the same port",
  async () => {
    let decoyRequests = 0;
    const intended = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ port: req.socket.localPort, path: req.url }));
    });
    const decoy = http.createServer((_req, res) => {
      decoyRequests += 1;
      res.end("wrong server");
    });
    // Allocate the IPv4 port first so a foreign IPv4 listener cannot own it.
    const address = await listen(decoy, { port: 0, host: "127.0.0.1" });
    await listen(intended, {
      port: address.port,
      host: "::",
      ipv6Only: true,
    });

    for (const client of [request(intended), request.agent(intended)]) {
      const response = await client.get("/chosen?value=1").expect(200);
      expect(response.body).toEqual({
        port: address.port,
        path: "/chosen?value=1",
      });
    }
    expect(decoyRequests).toBe(0);
  }
);

test("an automatically bound server receives requests on its allocated port", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ port: req.socket.localPort }));
  });
  servers.push(server);
  const pending = request(server).get("/allocated");
  const address = server.address() as AddressInfo;
  const url = new URL(pending.url);
  expect(Number(url.port)).toBe(address.port);
  expect(url.hostname).toBe(
    useIPv6Loopback && address.family === "IPv6" ? "[::1]" : "127.0.0.1"
  );
  expect((await pending.expect(200)).body).toEqual({ port: address.port });
  expect(server.listening).toBe(false);
});

test("an IPv4 server and explicit URL retain their selected port", async () => {
  const server = http.createServer((req, res) => {
    res.end(String(req.socket.localPort));
  });
  const address = await listen(server, { port: 0, host: "127.0.0.1" });
  await request(server).get("/").expect(200, String(address.port));
  await request(`http://127.0.0.1:${address.port}`)
    .get("/")
    .expect(200, String(address.port));
  expect(server.listening).toBe(true);
});

test("function apps and agents keep cookies and automatic server cleanup", async () => {
  const app: http.RequestListener = (req, res) => {
    res.setHeader("Set-Cookie", "session=present; Path=/");
    res.end(req.headers.cookie || "first visit");
  };
  await request(app).get("/").expect(200, "first visit");
  const agent = request.agent(app);
  await agent.get("/").expect(200, "first visit");
  await agent.get("/").expect(200, "session=present");
});

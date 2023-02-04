import Config from '../src/config';

describe("getServerNameWithProtocol", () => {
  it("should return https://pol.is", () => {
    const req = {
      protocol: 'https',
      headers: {
        host: 'pol.is'
      }
    };
    expect(Config.getServerNameWithProtocol(req)).toEqual('https://pol.is');
  });
});

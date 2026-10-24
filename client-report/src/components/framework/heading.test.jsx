import React from "react";
import { render, screen } from "@testing-library/react";
import Heading from "./heading.jsx";

test("identifies the conversation in the report heading", () => {
  render(<Heading conversation={{ conversation_id: "abc123", topic: "Our community budget" }} />);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Our community budget");
  expect(screen.getByRole("link", { name: /abc123/ })).toHaveAttribute("href", expect.stringContaining("abc123"));
});

test.each([undefined, "", "   "])("keeps the report label when the topic is %p", (topic) => {
  render(<Heading conversation={{ conversation_id: "abc123", topic }} />);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Report");
  expect(screen.queryByText("undefined")).not.toBeInTheDocument();
});

test("renders the topic as text rather than HTML", () => {
  const topic = "<img src=x onerror=alert(1)>";
  const { container } = render(<Heading conversation={{ conversation_id: "abc123", topic }} />);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(topic);
  expect(container.querySelector("img")).toBeNull();
});

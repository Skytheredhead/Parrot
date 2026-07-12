import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App.jsx";

describe("Project Conversation prototype", () => {
  it("shows the post-first hierarchy", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Final rundown — Panthers vs. Tigers" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /opening tease/i })).toBeInTheDocument();
    expect(screen.getByText(/Move aerial open to 7:42/i)).toBeInTheDocument();
  });

  it("creates a local post", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getAllByRole("button", { name: /create a post/i })[0]);
    await user.type(screen.getByLabelText("Title"), "Sponsor slate approved");
    await user.type(
      screen.getByLabelText("Post body"),
      "The final sponsor slate is ready for the game-day crew.",
    );
    await user.click(screen.getByRole("button", { name: "Publish post" }));
    expect(screen.getByRole("heading", { name: "Sponsor slate approved" })).toBeInTheDocument();
  });

  it("approves an accountable agent action", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      screen.getByRole("button", { name: /Rundown assistant checked 12 source files/i }),
    );
    await user.click(screen.getByRole("button", { name: "Approve update" }));
    expect(screen.getAllByText(/cue sheet update approved/i)).toHaveLength(2);
  });
});

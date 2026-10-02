import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  FieldError,
  FormAlert,
  PasswordField,
  PasswordRequirements,
  TextField,
} from "@/components/forms/fields";

describe("TextField", () => {
  it("labels the input and marks optional fields", () => {
    render(<TextField label="Company" optional defaultValue="" />);
    const input = screen.getByRole("textbox", { name: "Company (optional)" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("links the hint and the error to the input", () => {
    render(<TextField label="Email" hint="We never share it" error="Enter a valid email" />);
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("We never share it Enter a valid email");
  });

  it("passes input props through", async () => {
    const user = userEvent.setup();
    render(<TextField label="City" placeholder="London" maxLength={5} />);
    const input = screen.getByRole("textbox", { name: "City" });
    expect(input).toHaveAttribute("placeholder", "London");
    await user.type(input, "Manchester");
    expect(input).toHaveValue("Manch");
  });
});

describe("FieldError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<FieldError id="x" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the message with the given id", () => {
    render(<FieldError id="x-error" message="Required" />);
    expect(screen.getByText("Required")).toHaveAttribute("id", "x-error");
  });
});

describe("PasswordField", () => {
  it("toggles visibility with a pressed-state button", async () => {
    const user = userEvent.setup();
    render(<PasswordField label="Password" />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("shows content before the input, a hint and an error", () => {
    render(
      <PasswordField
        label="New password"
        hint="Use a passphrase"
        error="Too common"
        before={<p>Requirements here</p>}
      />,
    );
    const input = screen.getByLabelText("New password");
    expect(screen.getByText("Requirements here")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Use a passphrase Too common");
  });
});

describe("PasswordRequirements", () => {
  it("lists every requirement as not met before typing, with no meter", () => {
    render(<PasswordRequirements password="" email="ada@example.com" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("At least 10 characters(not yet met)");
    expect(items[1]).toHaveTextContent("Not your email address(not yet met)");
    expect(screen.queryByText(/Strength:/)).not.toBeInTheDocument();
  });

  it.each([
    ["short", "Weak"],
    ["abcdefghij", "Fair"],
    ["correct horse battery staple", "Strong"],
  ])("rates %j as %s", (password, label) => {
    render(<PasswordRequirements password={password} email="" />);
    expect(screen.getByText(`Strength: ${label}`)).toBeInTheDocument();
  });

  it("ticks requirements as they are met", () => {
    render(<PasswordRequirements password="correct horse" email="ada@example.com" />);
    for (const item of screen.getAllByRole("listitem")) {
      expect(item).toHaveTextContent("(met)");
    }
  });
});

describe("FormAlert", () => {
  it("is an alert that takes focus, with optional detail", () => {
    render(<FormAlert title="Something broke">Try again.</FormAlert>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent("Something broke");
    expect(alert).toHaveTextContent("Try again.");
  });

  it.each(["success", "info"] as const)("is a status for tone %s", (tone) => {
    render(<FormAlert tone={tone} title="All good" />);
    expect(screen.getByRole("status")).toHaveTextContent("All good");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

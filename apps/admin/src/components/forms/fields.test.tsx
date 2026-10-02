import { render, screen, within } from "@testing-library/react";
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
  it("labels the input and links hint and error through aria-describedby", () => {
    render(<TextField label="Store name" hint="Shown in emails." error="Enter a name" />);
    const input = screen.getByLabelText("Store name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Shown in emails. Enter a name");
  });

  it("is neither invalid nor described when there is no hint or error", () => {
    render(<TextField label="Phone" optional />);
    const input = screen.getByRole("textbox", { name: "Phone (optional)" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("passes input props through", async () => {
    render(<TextField label="Email" type="email" defaultValue="a@b" />);
    const input = screen.getByLabelText("Email");
    await userEvent.setup().type(input, ".c");
    expect(input).toHaveValue("a@b.c");
  });
});

describe("FieldError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<FieldError id="e" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the message with its id", () => {
    render(<FieldError id="e" message="Required" />);
    expect(screen.getByText("Required")).toHaveAttribute("id", "e");
  });
});

describe("PasswordField", () => {
  it("toggles visibility with a pressed-state button", async () => {
    render(<PasswordField label="Password" hint="10+ characters" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAccessibleDescription("10+ characters");
    const show = screen.getByRole("button", { name: "Show password" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    await user.click(show);
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("shows an error and the content passed as `before`", () => {
    render(<PasswordField label="Password" error="Too short" before={<p>Requirements</p>} />);
    expect(screen.getByText("Requirements")).toBeInTheDocument();
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Too short");
  });
});

describe("PasswordRequirements", () => {
  it("lists every rule as not yet met before typing, with no strength meter", () => {
    render(<PasswordRequirements password="" email="ada@example.com" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).toHaveTextContent("(not yet met)");
    expect(screen.queryByText(/Strength:/)).not.toBeInTheDocument();
  });

  it("ticks rules as they are met and rates the strength", () => {
    render(<PasswordRequirements password="correct horse battery" email="ada@example.com" />);
    const [length, email] = screen.getAllByRole("listitem");
    expect(length).toHaveTextContent("At least 10 characters(met)");
    expect(email).toHaveTextContent("Not your email address(met)");
    expect(screen.getByText("Strength: Strong")).toBeInTheDocument();
  });

  it.each([
    ["short", "Weak"],
    ["abcdefghij", "Fair"],
  ])("rates %j as %s", (password, label) => {
    render(<PasswordRequirements password={password} email="" />);
    expect(screen.getByText(`Strength: ${label}`)).toBeInTheDocument();
  });
});

describe("FormAlert", () => {
  it("is an alert for errors and takes focus", () => {
    render(
      <FormAlert title="Something failed">
        <span>Try again</span>
      </FormAlert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(within(alert).getByText("Try again")).toBeInTheDocument();
  });

  it.each(["success", "info"] as const)("is a status for the %s tone", (tone) => {
    render(<FormAlert tone={tone} title="Saved" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});

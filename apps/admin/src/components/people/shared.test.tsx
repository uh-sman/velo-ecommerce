import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithMe, staff } from "@/test/render";

import {
  CheckField,
  LoadMore,
  RadioGroup,
  RequirePermission,
  SelectField,
  TextAreaField,
  fullName,
  problemMessage,
  useDebounced,
  useResource,
} from "./shared";

describe("problemMessage", () => {
  it("prefers the detail, and falls back to the title", () => {
    expect(problemMessage({ type: "t", title: "Title", status: 400, detail: "Detail" })).toBe(
      "Detail",
    );
    expect(problemMessage({ type: "t", title: "Title", status: 400 })).toBe("Title");
  });
});

describe("fullName", () => {
  it("joins whichever names exist", () => {
    expect(fullName({ first_name: "Ada", last_name: "Lovelace" })).toBe("Ada Lovelace");
    expect(fullName({ first_name: null, last_name: "Lovelace" })).toBe("Lovelace");
    expect(fullName({ first_name: null, last_name: null })).toBe("");
  });
});

describe("useDebounced", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on the last value once the delay passes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 200), {
      initialProps: { value: "a" },
    });
    rerender({ value: "ab" });
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("abc");
  });
});

describe("useResource", () => {
  it("leaves a failed load alone when asked to mutate it", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        problem: { type: "t", title: "Nope", status: 500 },
      }),
    );
    const { result } = renderHook(() => useResource<number>(fetcher, "k"));
    await vi.waitFor(() => {
      expect(result.current.load).toEqual({ state: "error", message: "Nope" });
    });
    act(() => {
      result.current.mutate((value) => value + 1);
    });
    expect(result.current.load).toEqual({ state: "error", message: "Nope" });
  });
});

describe("RequirePermission", () => {
  it("shows the page to a role with the permission", () => {
    renderWithMe(
      <RequirePermission permission="audit:read" title="Audit log">
        <p>The log</p>
      </RequirePermission>,
    );
    expect(screen.getByText("The log")).toBeInTheDocument();
  });

  it("explains, instead of showing, to a role without it", () => {
    renderWithMe(
      <RequirePermission permission="audit:read" title="Audit log">
        <p>The log</p>
      </RequirePermission>,
      { me: staff({ role: "staff", permissions: ["admin:access"] }) },
    );
    expect(screen.queryByText("The log")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByText("Your role does not include this page")).toBeInTheDocument();
  });
});

describe("SelectField", () => {
  it("links its hint and error to the control", () => {
    render(
      <SelectField label="Role" hint="Pick one" error="Required" defaultValue="a">
        <option value="a">A</option>
      </SelectField>,
    );
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription("Pick one Required");
  });

  it("has no description without a hint or an error", () => {
    render(
      <SelectField label="Role" hideLabel defaultValue="a">
        <option value="a">A</option>
      </SelectField>,
    );
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).not.toHaveAttribute("aria-describedby");
    expect(select).not.toHaveAttribute("aria-invalid");
  });
});

describe("TextAreaField", () => {
  it("links its hint and error to the control", () => {
    render(<TextAreaField label="Note" hint="Staff only" error="Too long" defaultValue="" />);
    const area = screen.getByRole("textbox", { name: "Note" });
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(area).toHaveAccessibleDescription("Staff only Too long");
  });

  it("has no description without a hint or an error", () => {
    render(<TextAreaField label="Note" defaultValue="" />);
    expect(screen.getByRole("textbox", { name: "Note" })).not.toHaveAttribute("aria-describedby");
  });
});

describe("CheckField", () => {
  it("reports the new checked state and describes itself with the hint", async () => {
    const onChange = vi.fn();
    render(<CheckField label="Stackable" hint="Combines" checked={false} onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Stackable" });
    expect(box).toHaveAccessibleDescription("Combines");
    await userEvent.setup().click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("cannot be changed when disabled", () => {
    render(<CheckField label="Active" checked onChange={vi.fn()} disabled />);
    const box = screen.getByRole("checkbox", { name: "Active" });
    expect(box).toBeDisabled();
    expect(box).not.toHaveAttribute("aria-describedby");
  });
});

describe("RadioGroup", () => {
  function Harness({ error }: { error?: string }) {
    const [value, setValue] = useState<"a" | "b">("a");
    return (
      <RadioGroup
        legend="Kind"
        name="kind"
        value={value}
        options={[
          { value: "a", label: "Alpha", hint: "First" },
          { value: "b", label: "Bravo" },
        ]}
        onChange={setValue}
        error={error}
        inline
      />
    );
  }

  it("selects the chosen option", async () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: /Alpha/ })).toBeChecked();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Bravo" }));
    expect(screen.getByRole("radio", { name: "Bravo" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Alpha/ })).not.toBeChecked();
  });

  it("describes the group with its error", () => {
    render(<Harness error="Choose one" />);
    expect(screen.getByRole("group", { name: "Kind" })).toHaveAccessibleDescription("Choose one");
  });
});

describe("LoadMore", () => {
  it("counts what is shown and offers more", async () => {
    const onLoadMore = vi.fn();
    render(
      <LoadMore
        hasMore
        loading={false}
        error={null}
        onLoadMore={onLoadMore}
        shown={50}
        total={120}
        noun="customers"
      />,
    );
    expect(screen.getByText("Showing 50 of 120 customers")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("shows its pending state and a retry after a failure", () => {
    const { rerender } = render(
      <LoadMore
        hasMore
        loading
        error={null}
        onLoadMore={vi.fn()}
        shown={1}
        total={null}
        noun="x"
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(screen.getByText("Showing 1 x")).toBeInTheDocument();
    rerender(
      <LoadMore
        hasMore
        loading={false}
        error="Down"
        onLoadMore={vi.fn()}
        shown={1}
        total={null}
        noun="x"
      />,
    );
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("offers nothing more at the end", () => {
    render(
      <LoadMore
        hasMore={false}
        loading={false}
        error={null}
        onLoadMore={vi.fn()}
        shown={3}
        total={3}
        noun="x"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

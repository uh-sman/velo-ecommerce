import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  blankVariant,
  currentOptions,
  draftFromVariant,
  generateVariants,
  MAX_VARIANTS,
  newKey,
  OptionBuilder,
  optionsFromProduct,
  optionValues,
  usableOptions,
  validateVariants,
  variantChanges,
  variantInput,
  variantLabel,
  VariantGrid,
  type OptionDraft,
  type VariantDraft,
  type VariantErrors,
} from "@/components/catalog/variant-matrix";
import { productView, variantView } from "@/test/fixtures/catalog-editor";

// Typing and 250-row grids are slow in jsdom; leave room on a busy machine.
vi.setConfig({ testTimeout: 45_000 });

function option(name: string, values: string): OptionDraft {
  return { key: newKey("option"), name, values };
}

function row(overrides: Partial<VariantDraft> = {}): VariantDraft {
  return { ...blankVariant({}), sku: "SKU-1", price: "10.00", ...overrides };
}

describe("option parsing", () => {
  it("splits, trims and de-duplicates comma-separated values", () => {
    expect(optionValues(option("Size", " S, M ,,S, L "))).toEqual(["S", "M", "L"]);
  });

  it("keeps only options with a name and a value", () => {
    expect(
      usableOptions([option(" Size ", "S"), option("", "Red"), option("Colour", " , ")]),
    ).toEqual([{ name: "Size", values: ["S"] }]);
  });

  it("reads options and variants from a product", () => {
    const product = productView({
      options: [{ name: "Size", values: [{ value: "S" }, { value: "M" }] }],
    });
    expect(optionsFromProduct(product)).toEqual([
      expect.objectContaining({ name: "Size", values: "S, M" }),
    ]);
    const draft = draftFromVariant(
      variantView({ compare_at: { amount: 3000, currency: "USD" }, cost: null, stock: null }),
    );
    expect(draft).toMatchObject({
      id: draft.key,
      price: "25.00",
      compareAt: "30.00",
      cost: "",
      barcode: "",
      stock: "0",
      deleted: false,
    });
    expect(draftFromVariant(variantView({ barcode: "123" })).stock).toBe("9");
  });

  it("a blank variant copies prices from a template, never the SKU", () => {
    const template = row({ price: "5.00", compareAt: "9.00", cost: "1.00", sku: "T" });
    expect(blankVariant({ Size: "M" }, template)).toMatchObject({
      id: null,
      options: { Size: "M" },
      sku: "",
      price: "5.00",
      compareAt: "9.00",
      cost: "1.00",
      stock: "0",
    });
  });
});

describe("generateVariants", () => {
  it("adds every missing combination with a suggested SKU and the first row's prices", () => {
    const existing = row({ options: { Size: "S", Colour: "Red" }, price: "20.00" });
    const result = generateVariants(
      [option("Size", "S, M"), option("Colour", "Red, Blue")],
      [existing],
      "Linen tee!",
    );
    expect(result.added).toBe(3);
    expect(result.capped).toBe(false);
    expect(result.rows[0]).toBe(existing);
    expect(result.rows.slice(1).map((r) => r.sku)).toEqual([
      "LINEN-TEE-S-BLUE",
      "LINEN-TEE-M-RED",
      "LINEN-TEE-M-BLUE",
    ]);
    expect(result.rows.slice(1).every((r) => r.price === "20.00")).toBe(true);
  });

  it("does nothing without usable options", () => {
    const rows = [row()];
    expect(generateVariants([option("Size", "")], rows, "x")).toEqual({
      rows,
      added: 0,
      capped: false,
    });
  });

  it("treats deleted rows as missing and drops an empty SKU base", () => {
    const deleted = row({ options: { Size: "S" }, deleted: true });
    const result = generateVariants([option("Size", "S")], [deleted], "");
    expect(result.added).toBe(1);
    expect(result.rows[1]?.sku).toBe("S");
  });

  it("stops at the variant cap", () => {
    const values = Array.from({ length: 16 }, (_, i) => `v${String(i)}`).join(",");
    const result = generateVariants([option("A", values), option("B", values)], [], "p");
    expect(result.capped).toBe(true);
    expect(result.added).toBe(MAX_VARIANTS);
  });
});

describe("variantLabel", () => {
  it("joins the option values, else uses the variant title or Default", () => {
    expect(variantLabel(row({ options: { Size: "S", Colour: "Red" } }), ["Size", "Colour"])).toBe(
      "S / Red",
    );
    expect(variantLabel(draftFromVariant(variantView({ title: "Only" })), [])).toBe("Only");
    expect(variantLabel(row(), [])).toBe("Default");
  });
});

describe("validateVariants", () => {
  const size = [option("Size", "S, M")];

  it("accepts a complete row", () => {
    expect(validateVariants([row({ options: { Size: "S" } })], size)).toEqual({});
  });

  it("flags every blocking problem on its row and field", () => {
    const a = row({
      key: "a",
      sku: " ",
      price: "",
      compareAt: "abc",
      cost: "x",
      stock: "-1",
      options: {},
    });
    const b = row({
      key: "b",
      sku: "dup",
      price: "12.345",
      compareAt: "5.00",
      options: { Size: "S" },
    });
    const c = row({ key: "c", sku: "DUP", price: "10.00", options: { Size: "S" } });
    const gone = row({ key: "gone", sku: "", deleted: true });
    const errors = validateVariants([a, b, c, gone], size);
    expect(errors["a"]).toEqual({
      sku: "Required.",
      price: "Required.",
      compareAt: "An amount such as 39.99.",
      cost: "An amount such as 12.00.",
      stock: "A whole number, zero or more.",
      options: "Choose Size.",
    });
    expect(errors["b"]).toEqual({
      price: "An amount such as 29.99.",
      compareAt: "Must exceed the price.",
    });
    expect(errors["c"]).toEqual({
      sku: "Used by another variant here.",
      options: "Another variant has these options.",
    });
    expect(errors["gone"]).toBeUndefined();
  });

  it("does not ask existing variants for opening stock", () => {
    const existing = { ...draftFromVariant(variantView()), stock: "lots" };
    expect(validateVariants([existing], [option("Size", "S")])).toEqual({});
  });
});

describe("request bodies", () => {
  it("variantInput sends minor units, nulls for blanks, and only current options", () => {
    const draft = row({
      sku: " TEE-M ",
      price: "29.99",
      compareAt: "39.99",
      cost: "",
      barcode: " ",
      stock: "4",
      options: { Size: "M", Removed: "x" },
    });
    expect(variantInput(draft, [option("Size", "S, M")], "EUR")).toEqual({
      sku: "TEE-M",
      price: 2999,
      currency: "EUR",
      compare_at: 3999,
      cost: null,
      barcode: null,
      options: { Size: "M" },
      stock: 4,
      reorder_point: 5,
      track_inventory: true,
      allow_backorder: false,
      requires_shipping: true,
      is_taxable: true,
    });
    const odd = variantInput(
      row({ price: "", cost: "1.50", barcode: "B1", stock: "x" }),
      [],
      "USD",
    );
    expect(odd).toMatchObject({ price: 0, cost: 150, barcode: "B1", stock: 0, compare_at: null });
  });

  it("currentOptions skips options the row has no value for", () => {
    expect(
      currentOptions(row({ options: { Size: "S" } }), [option("Size", "S"), option("C", "R")]),
    ).toEqual({ Size: "S" });
  });

  it("variantChanges sends only what changed", () => {
    const sizes = [option("Size", "S, M")];
    const base = draftFromVariant(variantView());
    expect(variantChanges(base, sizes)).toBeNull();
    expect(variantChanges(row(), sizes)).toBeNull();
    expect(variantChanges({ ...base, deleted: true }, sizes)).toBeNull();
    expect(
      variantChanges(
        {
          ...base,
          sku: "TEE-S2",
          price: "26.00",
          compareAt: "30.00",
          cost: "",
          barcode: "999",
          options: { Size: "M" },
        },
        sizes,
      ),
    ).toEqual({
      sku: "TEE-S2",
      price: 2600,
      compare_at: 3000,
      cost: null,
      barcode: "999",
      options: { Size: "M" },
    });
    // An unparseable price is not sent; removing every option is.
    expect(variantChanges({ ...base, price: "abc" }, [])).toEqual({ options: {} });
  });
});

describe("OptionBuilder", () => {
  function Harness({
    initial,
    onGenerate = () => {},
    disabled = false,
  }: {
    initial: OptionDraft[];
    onGenerate?: () => void;
    disabled?: boolean;
  }) {
    const [options, setOptions] = useState(initial);
    return (
      <OptionBuilder
        options={options}
        onChange={setOptions}
        onGenerate={onGenerate}
        disabled={disabled}
      />
    );
  }

  it("adds, edits and removes options, and counts the combinations", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<Harness initial={[]} onGenerate={onGenerate} />);
    expect(screen.queryByRole("button", { name: /Generate variants/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add an option" }));
    await user.type(screen.getByLabelText("Option 1 name"), "Size");
    await user.type(screen.getByLabelText("Values"), "S, M, L");
    await user.click(screen.getByRole("button", { name: "Add an option" }));
    await user.type(screen.getByLabelText("Option 2 name"), "Colour");
    await user.type(screen.getAllByLabelText("Values")[1] as HTMLElement, "Red, Blue");

    await user.click(screen.getByRole("button", { name: "Generate variants (6)" }));
    expect(onGenerate).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Add an option" }));
    expect(screen.queryByRole("button", { name: "Add an option" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove option 3" }));
    await user.click(screen.getByRole("button", { name: "Remove option Size" }));
    expect(screen.getByLabelText("Option 1 name")).toHaveValue("Colour");
    expect(screen.getByRole("button", { name: "Generate variants (2)" })).toBeInTheDocument();
  });

  it("caps the count it shows and can be disabled", () => {
    const values = Array.from({ length: 16 }, (_, i) => String(i)).join(",");
    render(<Harness initial={[option("A", values), option("B", values)]} disabled />);
    expect(screen.getByRole("button", { name: "Generate variants (250+)" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Options" })).toBeDisabled();
  });
});

describe("VariantGrid", () => {
  function Harness({
    initial,
    options = [],
    errors = {},
    disabled = false,
    onAdd = () => {},
  }: {
    initial: VariantDraft[];
    options?: OptionDraft[];
    errors?: Record<string, VariantErrors>;
    disabled?: boolean;
    onAdd?: () => void;
  }) {
    const [rows, setRows] = useState(initial);
    return (
      <>
        <VariantGrid
          rows={rows}
          options={options}
          currency="USD"
          errors={errors}
          disabled={disabled}
          onChange={setRows}
          onAdd={onAdd}
        />
        <output aria-label="state">{JSON.stringify(rows.map((r) => [r.sku, r.deleted]))}</output>
      </>
    );
  }

  it("offers to add the first variant when there are none", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<Harness initial={[]} onAdd={onAdd} />);
    expect(screen.getByText("No variants yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("edits fields inline, shows margin, and marks new rows", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[row({ key: "n", sku: "NEW-1", price: "20.00", cost: "5.00" })]}
        options={[]}
      />,
    );
    const table = screen.getByRole("table", { name: "Variants" });
    expect(within(table).getByRole("columnheader", { name: "Variant" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Price (USD)" })).toBeInTheDocument();
    expect(within(table).getByText("New")).toBeInTheDocument();
    expect(within(table).getByText("75%")).toBeInTheDocument();

    const sku = screen.getByRole("textbox", { name: "SKU, Default" });
    await user.clear(sku);
    await user.type(sku, "NEW-2");
    expect(screen.getByRole("status", { name: "state" })).toHaveTextContent('"NEW-2"');

    await user.clear(screen.getByRole("textbox", { name: "Cost, Default" }));
    expect(within(table).getByText("—")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Opening stock, Default" }), "3");
    expect(screen.getByRole("textbox", { name: "Opening stock, Default" })).toHaveValue("03");

    // A new row is removed outright.
    await user.click(screen.getByRole("button", { name: "Remove variant Default" }));
    expect(screen.getByText("No variants yet")).toBeInTheDocument();
  });

  it("chooses option values per row and links existing stock to Inventory", async () => {
    const user = userEvent.setup();
    const existing = draftFromVariant(variantView());
    render(<Harness initial={[existing]} options={[option("Size", "S, M")]} />);
    const select = screen.getByRole("combobox", { name: "Size, variant S" });
    await user.selectOptions(select, "M");
    expect(screen.getByRole("combobox", { name: "Size, variant M" })).toHaveValue("M");
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Adjust" })).toHaveAttribute(
      "href",
      "/inventory?q=TEE-S",
    );
    expect(screen.queryByRole("textbox", { name: /Opening stock/ })).not.toBeInTheDocument();
  });

  it("marks an existing row for deletion and can keep it again", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[draftFromVariant(variantView({ stock: null }))]}
        options={[option("Size", "S")]}
      />,
    );
    expect(screen.getByText("—", { selector: "span" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove variant S" }));
    expect(screen.getByText("Deleted when you save")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SKU, S" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Size, variant S" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep variant S" }));
    expect(screen.queryByText("Deleted when you save")).not.toBeInTheDocument();
  });

  it("shows a deleted, option-less row as such", () => {
    render(<Harness initial={[{ ...draftFromVariant(variantView()), deleted: true }]} />);
    expect(screen.getByText("Deleted when you save")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep variant S" })).toBeInTheDocument();
  });

  it("links field, option and row errors to their controls", () => {
    const n = row({ key: "n", options: {} });
    render(
      <Harness
        initial={[n]}
        options={[option("Size", "S")]}
        errors={{ n: { sku: "Required.", options: "Choose Size.", row: "Server said no." } }}
      />,
    );
    const sku = screen.getByRole("textbox", { name: "SKU, Default" });
    expect(sku).toHaveAttribute("aria-invalid", "true");
    expect(sku).toHaveAccessibleDescription("Required.");
    const size = screen.getByRole("combobox", { name: "Size, variant Default" });
    expect(size).toHaveAccessibleDescription("Choose Size.");
    expect(screen.getByText("Server said no.")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("disables adding at the variant cap, or when the grid is read-only", () => {
    const many = Array.from({ length: MAX_VARIANTS }, (_, i) =>
      row({ key: `r${String(i)}`, sku: `S${String(i)}` }),
    );
    const { unmount } = render(<Harness initial={many} />);
    expect(screen.getByRole("button", { name: "Add a variant" })).toBeDisabled();
    unmount();
    render(<Harness initial={[]} disabled />);
    expect(screen.getByRole("button", { name: "Add a variant" })).toBeDisabled();
  });
});

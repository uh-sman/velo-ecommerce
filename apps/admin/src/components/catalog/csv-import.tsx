"use client";

import type { Schema } from "@velo/api-client";
import { CheckCircle2Icon, FileUpIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";

import {
  COLUMN_HINT,
  guessMapping,
  IMPORT_COLUMNS,
  MAX_IMPORT_BYTES,
  parseCsv,
  rebuild,
  REQUIRED_COLUMNS,
  type ImportColumn,
} from "@/components/catalog/csv";
import { Badge, problemMessage, problemOf, rawApi, selectClass } from "@/components/catalog/shared";
import { FormAlert } from "@/components/forms/fields";
import { Section, td, th } from "@/components/page";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

type Report = Schema<"ImportReport">;
type Mapping = Record<ImportColumn, number | null>;

interface Parsed {
  name: string;
  headers: string[];
  records: string[][];
}

type Outcome = { ok: true; report: Report } | { ok: false; message: string };

async function sendImport(csv: string, dryRun: boolean): Promise<Outcome> {
  let response: Response;
  try {
    response = await rawApi(`/api/v1/admin/products/bulk-import?dry_run=${String(dryRun)}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv; charset=utf-8" },
      body: csv,
    });
  } catch {
    return { ok: false, message: problemMessage(await problemOf(null)) };
  }
  if (!response.ok) return { ok: false, message: problemMessage(await problemOf(response)) };
  return { ok: true, report: (await response.json()) as Report };
}

/*
 * Bulk import (API-SPEC.md "Bulk import"): pick a file, map its columns to
 * the export format, check it with a dry run that lists every problem by row
 * and column, and only then import. The API applies all of it or none of it.
 */
export function CsvImport() {
  const fileId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Report | null>(null);
  const [result, setResult] = useState<Report | null>(null);

  const reset = () => {
    setParsed(null);
    setMapping(null);
    setPreview(null);
    setResult(null);
    setRequestError(null);
    setFileError(null);
  };

  const choose = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError("The file is larger than 5 MB. Split it and import the parts one at a time.");
      return;
    }
    const rows = parseCsv(await file.text()).filter(
      (row) => !(row.length === 1 && row[0] === ""), // blank lines: the API skips them too
    );
    const [headers, ...records] = rows;
    if (!headers || records.length === 0) {
      setFileError("The file needs a header row and at least one product row.");
      return;
    }
    setParsed({ name: file.name, headers, records });
    setMapping(guessMapping(headers));
  };

  const missing = mapping ? REQUIRED_COLUMNS.filter((column) => mapping[column] === null) : [];
  const csv = useMemo(
    () => (parsed && mapping ? rebuild(parsed.records, mapping) : ""),
    [parsed, mapping],
  );

  const check = async () => {
    setChecking(true);
    setRequestError(null);
    setPreview(null);
    const outcome = await sendImport(csv, true);
    setChecking(false);
    if (outcome.ok) setPreview(outcome.report);
    else setRequestError(outcome.message);
  };

  const apply = async () => {
    setImporting(true);
    setRequestError(null);
    const outcome = await sendImport(csv, false);
    setImporting(false);
    if (!outcome.ok) {
      setRequestError(outcome.message);
      notify.error("Nothing was imported");
      return;
    }
    if (outcome.report.applied) {
      setResult(outcome.report);
      notify.success("Catalog imported");
    } else {
      // Something changed since the dry run; nothing was applied.
      setPreview(outcome.report);
      notify.error("Nothing was imported — see the problems below");
    }
  };

  if (result) {
    return (
      <Section>
        <div className="flex flex-col items-start gap-3">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <CheckCircle2Icon className="text-success size-5" aria-hidden />
            Imported {result.rows} rows
          </p>
          <Counts report={result} />
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/products">Go to products</Link>
            </Button>
            <Button variant="outline" onClick={reset}>
              Import another file
            </Button>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="1. Choose a file">
        <div className="flex flex-col gap-3">
          <p className="text-text-secondary text-sm">
            UTF-8 CSV, one row per variant, at most 5 MB or 10,000 rows. The easiest start is an
            export of the current catalog, edited in a spreadsheet.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={fileId} className="sr-only">
              CSV file
            </label>
            <input
              ref={input}
              id={fileId}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button variant="outline" onClick={() => input.current?.click()}>
              <FileUpIcon aria-hidden />
              {parsed ? "Choose another file" : "Choose a CSV file"}
            </Button>
            {parsed && (
              <p className="text-sm">
                <span className="font-medium">{parsed.name}</span>
                <span className="text-text-secondary">
                  {" "}
                  — {parsed.records.length} rows, {parsed.headers.length} columns
                </span>
              </p>
            )}
          </div>
          {fileError && <FormAlert title={fileError} />}
        </div>
      </Section>

      {parsed && mapping && (
        <Section title="2. Match the columns">
          <MappingTable
            parsed={parsed}
            mapping={mapping}
            onChange={(next) => {
              setMapping(next);
              setPreview(null);
            }}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => void check()} loading={checking} disabled={missing.length > 0}>
              Check the file
            </Button>
            {missing.length > 0 && (
              <p className="text-danger text-sm">Choose a column for: {missing.join(", ")}.</p>
            )}
          </div>
        </Section>
      )}

      {requestError && <FormAlert title={`The file was refused: ${requestError}`} />}

      {preview && parsed && mapping && (
        <Section title="3. Review and import">
          <PreviewReport
            report={preview}
            parsed={parsed}
            mapping={mapping}
            importing={importing}
            onImport={() => void apply()}
          />
        </Section>
      )}
    </div>
  );
}

function MappingTable({
  parsed,
  mapping,
  onChange,
}: {
  parsed: Parsed;
  mapping: Mapping;
  onChange: (mapping: Mapping) => void;
}) {
  const id = useId();
  const used = new Set(Object.values(mapping).filter((index): index is number => index !== null));
  const ignored = parsed.headers.filter((_, index) => !used.has(index));
  const sample = parsed.records[0] ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-secondary text-sm">
        Columns with the same name are matched for you. Only matched columns are sent.
      </p>
      <div className="border-border-subtle overflow-x-auto rounded-lg border">
        <table aria-label="Column mapping" className="w-full min-w-[40rem] text-left text-sm">
          <thead>
            <tr>
              <th className={th}>Velo column</th>
              <th className={th}>Column in your file</th>
              <th className={th}>First row</th>
            </tr>
          </thead>
          <tbody>
            {IMPORT_COLUMNS.map((column) => {
              const index = mapping[column];
              const required = REQUIRED_COLUMNS.includes(column);
              return (
                <tr key={column}>
                  <td className={td}>
                    <label htmlFor={`${id}-${column}`} className="font-mono text-xs font-medium">
                      {column}
                    </label>
                    {required && <Badge className="ml-2">Required</Badge>}
                    {COLUMN_HINT[column] && (
                      <p className="text-text-tertiary mt-0.5 text-xs">{COLUMN_HINT[column]}</p>
                    )}
                  </td>
                  <td className={td}>
                    <select
                      id={`${id}-${column}`}
                      className={cn(selectClass, "w-full min-w-48")}
                      value={index === null ? "" : String(index)}
                      aria-invalid={required && index === null ? true : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        onChange({ ...mapping, [column]: value === "" ? null : Number(value) });
                      }}
                    >
                      <option value="">Not imported</option>
                      {parsed.headers.map((header, headerIndex) => (
                        <option key={headerIndex} value={headerIndex}>
                          {header.trim() || `Column ${String(headerIndex + 1)} (no header)`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`${td} text-text-secondary max-w-56 truncate`}>
                    {index === null ? "—" : (sample[index] ?? "")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ignored.length > 0 && (
        <p className="text-text-secondary text-sm">
          Not sent: {ignored.map((header) => header.trim() || "(no header)").join(", ")}.
        </p>
      )}
    </div>
  );
}

function Counts({ report }: { report: Report }) {
  const items: [string, number][] = [
    ["Products created", report.products_created],
    ["Products updated", report.products_updated],
    ["Variants created", report.variants_created],
    ["Variants updated", report.variants_updated],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="border-border-subtle rounded-md border p-3">
          <dt className="text-text-secondary text-xs">{label}</dt>
          <dd className="text-xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewReport({
  report,
  parsed,
  mapping,
  importing,
  onImport,
}: {
  report: Report;
  parsed: Parsed;
  mapping: Mapping;
  importing: boolean;
  onImport: () => void;
}) {
  const problems = [...report.errors].sort((a, b) => a.row - b.row);
  /** The cell the API complained about, from the file as the operator sees it. */
  const cell = (row: number, column: string | null): string => {
    if (!column || !(IMPORT_COLUMNS as readonly string[]).includes(column)) return "";
    const index = mapping[column as ImportColumn];
    return index === null ? "" : (parsed.records[row - 2]?.[index] ?? "");
  };

  if (problems.length > 0) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert
          title={`${String(problems.length)} problem${problems.length === 1 ? "" : "s"} in ${String(report.rows)} rows — nothing will be imported until they are fixed`}
        >
          Fix them in the file and choose it again. Row numbers count the header as row 1, as a
          spreadsheet shows them.
        </FormAlert>
        <div className="border-border-subtle overflow-x-auto rounded-lg border">
          <table aria-label="Import problems" className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr>
                <th className={`${th} w-16`}>Row</th>
                <th className={th}>Column</th>
                <th className={th}>Value</th>
                <th className={th}>Problem</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((problem, index) => (
                <tr key={`${String(problem.row)}-${problem.column ?? ""}-${String(index)}`}>
                  <td className={`${td} tabular-nums`}>{problem.row}</td>
                  <td className={`${td} font-mono text-xs`}>{problem.column ?? "—"}</td>
                  <td className={`${td} text-text-secondary max-w-48 truncate`}>
                    {cell(problem.row, problem.column) || "—"}
                  </td>
                  <td className={td}>{problem.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <FormAlert
        tone="success"
        title={`No problems in ${String(report.rows)} rows. Ready to import.`}
      >
        The import is all or nothing: if anything fails on the way in, nothing changes.
      </FormAlert>
      <Counts report={report} />
      <Button onClick={onImport} loading={importing}>
        Import {report.rows} rows
      </Button>
    </div>
  );
}

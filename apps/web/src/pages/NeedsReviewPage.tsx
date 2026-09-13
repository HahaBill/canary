import { useState } from "react";
import {
  CATEGORIES,
  NON_OPERATING_CATEGORIES,
  type Category,
  type NeedsReviewResponse,
} from "@canary/shared";
import { KeyRound } from "lucide-react";
import { clearApiCache, submitClassificationOverride, useNeedsReview } from "@/api/useDerived.ts";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Popover } from "@/components/ui/popover.tsx";
import { Toaster, useToast } from "@/components/ui/toast.tsx";
import {
  categoryLabel,
  entityDisplayName,
  formatDateMedium,
  formatSignedUsd,
  formatTimestampMedium,
  formatUsdWhole,
} from "@/lib/format.ts";
import { useOperatorSecret } from "@/lib/secret.ts";

type Item = NeedsReviewResponse["items"][number];

/**
 * Categories a reviewer may assign: NEEDS_REVIEW is the state being resolved,
 * and the non-operating buckets plus REFUND are decided by flow type, not by a
 * person.
 */
const ASSIGNABLE: readonly Category[] = CATEGORIES.filter(
  (category) =>
    category !== "NEEDS_REVIEW" &&
    category !== "REFUND" &&
    !NON_OPERATING_CATEGORIES.includes(category),
);

export function NeedsReviewPage() {
  const { data, loading, error, reload } = useNeedsReview();
  const { secret, save } = useOperatorSecret();
  const { toast, show, dismiss } = useToast();

  async function assign(item: Item, category: Category, applyToMerchant: boolean, note: string) {
    if (!secret) return;
    try {
      await submitClassificationOverride(
        {
          transaction_id: item.transaction_id,
          category,
          apply_to_merchant: applyToMerchant,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        secret,
      );
      show(
        `${item.merchant_raw} filed under ${categoryLabel(category)}${applyToMerchant ? " for every transaction from this merchant" : ""}.`,
      );
      // Drops the review queue and the counts the dashboard and sidebar read.
      clearApiCache();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not save that category.", "error");
    }
  }

  // The Toaster stays mounted through the post-save refetch, so the
  // confirmation does not blink out while the queue reloads.
  return (
    <>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!error && !data ? (
        <div className="space-y-5">
          <PanelSkeleton className="h-16" />
          <PanelSkeleton className="h-72" />
        </div>
      ) : null}
      {!error && data ? (
        <Queue data={data} secret={secret} onSaveSecret={save} onAssign={assign} />
      ) : null}
      <Toaster toast={toast} onDismiss={dismiss} />
    </>
  );
}

function Queue({
  data,
  secret,
  onSaveSecret,
  onAssign,
}: {
  data: NeedsReviewResponse;
  secret: string | null;
  onSaveSecret: (secret: string) => void;
  onAssign: (item: Item, category: Category, applyToMerchant: boolean, note: string) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Needs Review
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-neutral-500">
          {data.count === 1 ? "1 transaction" : `${data.count} transactions`} totalling{" "}
          {formatUsdWhole(data.outflow_cents)} could not be corroborated. Nothing falls through
          silently — these amounts already count in cash and burn.
        </p>
      </header>

      {secret ? null : <SecretPrompt onSave={onSaveSecret} />}

      {data.items.length === 0 ? (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          The queue is empty. Every transaction in the ledger has a corroborated category.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Transactions awaiting a category</caption>
            <thead className="border-b border-neutral-200 bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Date
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Merchant
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">
                  Why it is here
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {data.items.map((item) => (
                <tr key={item.transaction_id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-600">
                    {formatDateMedium(item.date)}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-neutral-900">{item.merchant_raw}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">{item.merchant_normalized}</p>
                    <Proposals item={item} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-neutral-900">
                    {formatSignedUsd(item.amount_cents)}
                  </td>
                  <td className="hidden px-4 py-3 text-xs leading-relaxed text-neutral-500 lg:table-cell">
                    {item.reason}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AssignCategory
                      item={item}
                      merchantCount={
                        data.items.filter((i) => i.merchant_normalized === item.merchant_normalized)
                          .length
                      }
                      disabled={!secret}
                      onSubmit={onAssign}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RecentOverrides overrides={data.overrides} />

      <p className="text-[11px] leading-relaxed text-neutral-400">
        Categories proposed by OpenAI and corroborated by live search are shown as signals only. A
        transaction lands here when those signals disagree or are insufficient; assigning a category
        records an override and re-runs classification for that merchant.
      </p>
    </div>
  );
}

function Proposals({ item }: { item: Item }) {
  if (item.proposals.length === 0) return null;

  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
      {item.proposals.map((proposal, index) => {
        const label = proposal.category
          ? `${sourceLabel(proposal.source)} → ${categoryLabel(proposal.category as Category) ?? proposal.category}`
          : `${sourceLabel(proposal.source)} — no category`;
        return (
          <li key={`${proposal.source}-${index}`}>
            {proposal.url ? (
              <a
                href={proposal.url}
                target="_blank"
                rel="noreferrer"
                title={proposal.detail}
                className="inline-flex"
              >
                <Badge variant="outline" className="hover:bg-neutral-50">
                  {label} ↗
                </Badge>
              </a>
            ) : (
              <Badge variant="outline" title={proposal.detail}>
                {label}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** `OPENAI` → `OpenAI`; anything else is title-cased by the shared helper. */
function sourceLabel(source: string): string {
  if (source.toUpperCase() === "OPENAI") return "OpenAI";
  if (source.toUpperCase() === "TAVILY") return "Research";
  return entityDisplayName(source);
}

function AssignCategory({
  item,
  merchantCount,
  disabled,
  onSubmit,
}: {
  item: Item;
  merchantCount: number;
  disabled: boolean;
  onSubmit: (item: Item, category: Category, applyToMerchant: boolean, note: string) => Promise<void>;
}) {
  return (
    <Popover
      label={`Assign a category to ${item.merchant_raw}`}
      trigger={
        <Button variant="outline" size="sm">
          Assign category
        </Button>
      }
    >
      {(close) => (
        <AssignForm
          item={item}
          merchantCount={merchantCount}
          disabled={disabled}
          onSubmit={onSubmit}
          onDone={close}
        />
      )}
    </Popover>
  );
}

function AssignForm({
  item,
  merchantCount,
  disabled,
  onSubmit,
  onDone,
}: {
  item: Item;
  merchantCount: number;
  disabled: boolean;
  onSubmit: (item: Item, category: Category, applyToMerchant: boolean, note: string) => Promise<void>;
  onDone: () => void;
}) {
  // A proposal is a starting point, not an answer — and with no proposal the
  // reviewer has to choose rather than accept whatever sorts first.
  const suggested = item.proposals.find((p) => p.category)?.category;
  const [category, setCategory] = useState<Category | "">(
    ASSIGNABLE.includes(suggested as Category) ? (suggested as Category) : "",
  );
  const [applyToMerchant, setApplyToMerchant] = useState(true);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="space-y-2.5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!category) return;
        setSaving(true);
        await onSubmit(item, category, applyToMerchant, note);
        setSaving(false);
        onDone();
      }}
    >
      <label className="block text-xs font-medium text-neutral-700">
        Category
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as Category | "")}
          className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-[13px] text-neutral-900"
        >
          <option value="">Choose a category…</option>
          {ASSIGNABLE.map((option) => (
            <option key={option} value={option}>
              {categoryLabel(option)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2 text-xs leading-relaxed text-neutral-700">
        <input
          type="checkbox"
          checked={applyToMerchant}
          onChange={(event) => setApplyToMerchant(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-canary-500"
        />
        {merchantCount > 1
          ? `Apply to all ${merchantCount} transactions from this merchant`
          : "Apply to every transaction from this merchant"}
      </label>

      <label className="block text-xs font-medium text-neutral-700">
        Note <span className="font-normal text-neutral-400">(optional)</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="Why this category?"
          className="mt-1 w-full resize-none rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-[13px] text-neutral-900 placeholder:text-neutral-400"
        />
      </label>

      {disabled ? (
        <p className="text-[11px] leading-relaxed text-amber-700">
          Enter the operator secret above before saving.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={disabled || saving || !category}>
          {saving ? "Saving…" : "Save category"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SecretPrompt({ onSave }: { onSave: (secret: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
        setValue("");
      }}
      className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <label htmlFor="operator-secret" className="text-sm font-medium text-neutral-900">
            Enter operator secret
          </label>
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">
            Assigning a category writes to the ledger, so it is guarded by the shared secret this
            demo also uses for the iMessage webhook. It is kept in this browser only.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="operator-secret"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] text-neutral-900"
            />
            <Button type="submit" size="sm" disabled={value.trim().length === 0}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function RecentOverrides({ overrides }: { overrides: NeedsReviewResponse["overrides"] }) {
  if (overrides.length === 0) return null;

  return (
    <details className="rounded-2xl border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-neutral-900">
        Recent overrides
        <span className="ml-2 font-normal text-neutral-400">({overrides.length})</span>
      </summary>
      <ul className="divide-y divide-neutral-100 border-t border-neutral-100">
        {[...overrides].reverse().map((override) => (
          <li key={`${override.transaction_id}-${override.created_at}`} className="px-4 py-3">
            <p className="text-[13px] text-neutral-900">
              {entityDisplayName(override.merchant_normalized)} → {categoryLabel(override.category)}
              {override.apply_to_merchant ? (
                <span className="ml-2 text-xs text-neutral-400">all transactions</span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {formatTimestampMedium(override.created_at)}
              {override.note ? ` · ${override.note}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

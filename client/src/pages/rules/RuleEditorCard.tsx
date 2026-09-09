import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  QboAccountDto,
  RuleDetailDto,
  RuleDirection,
  RuleMutationKind,
  TagDto,
  TaxCalculation,
  TaxReadinessDto,
} from '@recat/shared';
import { isUsableTaxCodeForDirection } from '../../components/TaxCodePicker';
import TaxCodePicker from '../../components/TaxCodePicker';
import { Combobox, Select } from '../../components/SelectCombobox';
import type { PrepareRuleOperationBody } from '../../lib/api';

type Draft = {
  matchText: string;
  direction: RuleDirection | null;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation;
  taxCodeQboId: string | null;
  tagIds: string[];
  autoPost: boolean;
};

export type RuleEditorOperation = (
  rule: RuleDetailDto,
  mutation: Exclude<RuleMutationKind, 'create' | 'activate_candidate' | 'dismiss_candidate'>,
  proposal?: PrepareRuleOperationBody['proposal'],
) => void;

export interface RuleEditorCardProps {
  rule: RuleDetailDto;
  accounts: QboAccountDto[];
  tags: TagDto[];
  taxReadiness: TaxReadinessDto | null;
  operationBusy: boolean;
  testing: boolean;
  onOperation: RuleEditorOperation;
  onTest: (rule: RuleDetailDto, matchText: string, direction: RuleDirection) => void;
  footer?: (actions: ReactNode) => ReactNode;
}

function draftFromRule(rule: RuleDetailDto): Draft {
  const { revision } = rule;
  return {
    matchText: revision.condition.matchText,
    direction: revision.action?.direction ?? revision.direction,
    categoryQboId: revision.action?.categoryQboId ?? null,
    taxCalculation: revision.action?.taxCalculation ?? 'NotApplicable',
    taxCodeQboId: revision.action?.taxCodeQboId ?? null,
    tagIds: [...(revision.action?.tagIds ?? [])],
    autoPost: revision.autoPost,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function titleCaseState(state: 'enabled' | 'disabled'): 'Enabled' | 'Disabled' {
  return state === 'enabled' ? 'Enabled' : 'Disabled';
}

export default function RuleEditorCard({
  rule,
  accounts,
  tags,
  taxReadiness,
  operationBusy,
  testing,
  onOperation,
  onTest,
  footer,
}: RuleEditorCardProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromRule(rule));
  const { revision } = rule;

  useEffect(() => {
    setDraft(draftFromRule(rule));
  }, [rule.revision.id, rule.revision.revision]);

  const categoryAccounts = useMemo(() => accounts.filter((account) => (
    draft.direction === 'Deposit'
      ? account.classification === 'Income'
      : account.classification === 'Expenses' || account.classification === 'COGS'
  )), [accounts, draft.direction]);
  const category = accounts.find((account) => account.qboId === draft.categoryQboId) ?? null;
  const categoryValid = category !== null && categoryAccounts.includes(category);
  const taxDirection = draft.direction === 'Deposit' ? 'sales' : 'purchase';
  const taxValid = draft.taxCodeQboId === null
    ? draft.taxCalculation === 'NotApplicable'
    : draft.taxCalculation !== 'NotApplicable'
      && isUsableTaxCodeForDirection(taxReadiness, taxDirection, draft.taxCodeQboId);
  const availableTagIds = new Set(tags.map((tag) => tag.id));
  const unavailableTagIds = draft.tagIds.filter((id) => !availableTagIds.has(id));
  const valid = draft.matchText.trim().length > 0
    && draft.direction !== null
    && categoryValid
    && taxValid
    && unavailableTagIds.length === 0;

  const canonical = draftFromRule(rule);
  const ordinaryChanged = draft.matchText !== canonical.matchText
    || draft.direction !== canonical.direction
    || draft.categoryQboId !== canonical.categoryQboId
    || draft.taxCalculation !== canonical.taxCalculation
    || draft.taxCodeQboId !== canonical.taxCodeQboId
    || !sameIds(draft.tagIds, canonical.tagIds);
  const changed = ordinaryChanged || draft.autoPost !== canonical.autoPost;

  const buildProposal = (includeUnchanged = false): NonNullable<PrepareRuleOperationBody['proposal']> => {
    const proposal: NonNullable<PrepareRuleOperationBody['proposal']> = {};
    if (includeUnchanged || draft.matchText !== canonical.matchText) proposal.matchText = draft.matchText.trim();
    if (draft.direction && (includeUnchanged || draft.direction !== canonical.direction)) proposal.direction = draft.direction;
    if (draft.categoryQboId && (includeUnchanged || draft.categoryQboId !== canonical.categoryQboId)) proposal.categoryQboId = draft.categoryQboId;
    if (includeUnchanged || draft.taxCalculation !== canonical.taxCalculation) proposal.taxCalculation = draft.taxCalculation;
    if (includeUnchanged || draft.taxCodeQboId !== canonical.taxCodeQboId) proposal.taxCodeQboId = draft.taxCodeQboId;
    if (includeUnchanged || !sameIds(draft.tagIds, canonical.tagIds)) proposal.tagIds = [...draft.tagIds];
    if (draft.autoPost === false && (includeUnchanged || draft.autoPost !== canonical.autoPost)) proposal.autoPost = false;
    return proposal;
  };

  const setTaxCode = (taxCodeQboId: string | null) => {
    setDraft((current) => ({
      ...current,
      taxCodeQboId,
      taxCalculation: taxCodeQboId === null
        ? 'NotApplicable'
        : current.taxCalculation === 'NotApplicable'
          ? 'TaxInclusive'
          : current.taxCalculation,
    }));
  };

  const toggleTag = (tagId: string) => {
    setDraft((current) => ({
      ...current,
      tagIds: current.tagIds.includes(tagId)
        ? current.tagIds.filter((id) => id !== tagId)
        : [...current.tagIds, tagId],
    }));
  };

  const status = titleCaseState(rule.state);
  const held = rule.reviewRequiredAt !== null || rule.reviewReason !== null || rule.repairReason !== null;

  const actions = (
    <>
      <button
        type="button"
        className="btn-ghost"
        disabled={operationBusy || !draft.direction || draft.matchText.trim().length === 0 || testing}
        onClick={() => draft.direction && onTest(rule, draft.matchText.trim(), draft.direction)}
      >
        {testing ? 'Testing…' : 'Test rule'}
      </button>
      {!held && (
        <button
          type="button"
          className="btn-primary"
          disabled={operationBusy || !valid || !changed}
          onClick={() => onOperation(rule, 'update', buildProposal())}
        >
          Save rule
        </button>
      )}
      {held && (
        <button
          type="button"
          className="btn-primary"
          disabled={operationBusy || !valid}
          onClick={() => onOperation(rule, 'review', { ...buildProposal(true), reviewReason: 'Reviewed and saved.' })}
        >
          Review and save
        </button>
      )}
    </>
  );

  return (
    <article id={`rule-${revision.ruleId}`} className="rule-editor-card">
      <header className="rule-editor-header">
        <div>
          <strong>{revision.condition.matchText}</strong>
          <div className="rule-editor-meta">Revision {revision.revision}</div>
        </div>
        <button
          type="button"
          className={rule.state === 'enabled' ? 'pill-ok rule-status-pill' : 'pill-am rule-status-pill'}
          aria-label={status}
          disabled={operationBusy || (held && rule.state === 'disabled')}
          onClick={() => onOperation(
            rule,
            rule.state === 'enabled' ? 'disable' : 'enable',
            { autoPost: false },
          )}
        >
          {status}
        </button>
      </header>

      {(held || revision.invalidReasons.length > 0) && (
        <div className="rule-editor-notices">
          {held && <div role="alert" className="rule-warning">Review required{rule.reviewReason ? `: ${rule.reviewReason}` : ''}</div>}
          {revision.invalidReasons.map((reason) => <div key={reason} role="alert" className="rule-error">{reason}</div>)}
        </div>
      )}

      <div className="rule-editor-grid">
        <label className="field">
          <span className="field-label">Payee contains</span>
          <input
            className="text-control"
            value={draft.matchText}
            disabled={operationBusy}
            onChange={(event) => setDraft((current) => ({ ...current, matchText: event.target.value }))}
          />
        </label>
        <Select
          label="Direction"
          value={draft.direction}
          disabled={operationBusy}
          placeholder="Choose direction"
          options={[{ value: 'Purchase', label: 'Purchase' }, { value: 'Deposit', label: 'Deposit' }]}
          onValueChange={(direction) => setDraft((current) => ({ ...current, direction: direction as RuleDirection | null }))}
        />
        <div>
          <Combobox
            label="Category"
            value={draft.categoryQboId}
            disabled={operationBusy || draft.direction === null}
            placeholder="Choose category"
            options={categoryAccounts.map((account) => ({
              value: account.qboId,
              label: `${account.classification} · ${account.name}`,
              searchText: account.name,
            }))}
            onValueChange={(categoryQboId) => setDraft((current) => ({ ...current, categoryQboId }))}
            searchPlaceholder="Search categories…"
            emptyText="No matching categories"
          />
          {draft.categoryQboId !== null && !categoryValid && (
            <div role="alert" aria-label="Category needs repair" className="rule-field-error">
              {revision.action?.category ?? draft.categoryQboId} is not valid for {draft.direction ?? 'this direction'}. Choose a replacement.
            </div>
          )}
        </div>
        <div>
          <TaxCodePicker
            id={`rule-tax-${revision.ruleId}`}
            label="Tax code"
            direction={taxDirection}
            readiness={taxReadiness}
            value={draft.taxCodeQboId}
            unavailableValueLabel={revision.taxCodeName ?? undefined}
            disabled={operationBusy || draft.direction === null}
            onChange={setTaxCode}
          />
          {draft.taxCodeQboId !== null && !isUsableTaxCodeForDirection(taxReadiness, taxDirection, draft.taxCodeQboId) && (
            <div role="alert" aria-label="Tax code needs repair" className="rule-field-error">
              {revision.taxCodeName ?? draft.taxCodeQboId} is not available for {draft.direction ?? 'this direction'}. Choose No tax or a replacement.
            </div>
          )}
        </div>
        <Select
          label="Tax calculation"
          value={draft.taxCalculation}
          disabled={operationBusy || draft.taxCodeQboId === null}
          options={draft.taxCodeQboId === null
            ? [{ value: 'NotApplicable', label: 'Not applicable' }]
            : [
                { value: 'TaxInclusive', label: 'Tax inclusive' },
                { value: 'TaxExcluded', label: 'Tax exclusive' },
              ]}
          onValueChange={(taxCalculation) => {
            if (taxCalculation) setDraft((current) => ({ ...current, taxCalculation: taxCalculation as TaxCalculation }));
          }}
        />
        <fieldset className="rule-tag-field" disabled={operationBusy}>
          <legend>Tags</legend>
          {tags.map((tag) => (
            <label key={tag.id}>
              <input type="checkbox" checked={draft.tagIds.includes(tag.id)} onChange={() => toggleTag(tag.id)} />
              {tag.name}
            </label>
          ))}
          {unavailableTagIds.map((tagId) => (
            <label key={tagId} className="rule-field-error">
              <input type="checkbox" checked onChange={() => toggleTag(tagId)} />
              Unavailable tag ({tagId}) — remove to repair
            </label>
          ))}
        </fieldset>
        <label className="rule-auto-post">
          <input
            type="checkbox"
            aria-label="Auto-post"
            checked={draft.autoPost}
            disabled={operationBusy || rule.state === 'disabled' || (!canonical.autoPost && ordinaryChanged)}
            onChange={(event) => {
              if (event.target.checked && !canonical.autoPost) {
                onOperation(rule, 'update', { autoPost: true });
              } else {
                setDraft((current) => ({ ...current, autoPost: event.target.checked }));
              }
            }}
          />
          Auto-post
          {!canonical.autoPost && ordinaryChanged && (
            <span className="rule-auto-post-note">Save or discard draft changes before enabling auto-post.</span>
          )}
        </label>
      </div>

      {footer ? footer(actions) : <div className="rule-editor-actions">{actions}</div>}
    </article>
  );
}

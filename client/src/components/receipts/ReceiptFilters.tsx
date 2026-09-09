import { Select } from '../SelectCombobox';
import type {
  ReceiptDocumentStatus,
  ReceiptListParams,
} from '@recat/shared';

export type ReceiptQuickFilter =
  | { label: string; statuses: ReceiptDocumentStatus[]; duplicate?: false }
  | { label: 'Duplicates'; statuses: []; duplicate: true };

export const RECEIPT_QUICK_FILTERS: ReceiptQuickFilter[] = [
  { label: 'All', statuses: [] },
  { label: 'Needs review', statuses: ['NEEDS_REVIEW'] },
  { label: 'Ready', statuses: ['READY'] },
  { label: 'Matched', statuses: ['MATCHED'] },
  { label: 'Attached', statuses: ['ATTACHED'] },
  { label: 'Processing', statuses: ['QUEUED', 'PROCESSING'] },
  { label: 'Failed', statuses: ['FAILED'] },
  { label: 'Duplicates', statuses: [], duplicate: true },
];

interface ReceiptFiltersProps {
  quickLabel: string;
  search: string;
  onQuickFilter(filter: ReceiptQuickFilter): void;
  onSearch(value: string): void;
  filters: ReceiptListParams;
  onFilters(filters: ReceiptListParams): void;
  duplicateMode?: boolean;
}

export default function ReceiptFilters({
  quickLabel,
  search,
  onQuickFilter,
  onSearch,
  filters,
  onFilters,
  duplicateMode = false,
}: ReceiptFiltersProps) {
  const update = (patch: ReceiptListParams) => onFilters({
    ...filters,
    ...patch,
  });
  return (
    <div className="receipt-filters">
      <div
        role="group"
        aria-label="Receipt status"
        className="receipt-filter-chips"
      >
        {RECEIPT_QUICK_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className="btn receipt-filter-chip"
            aria-pressed={quickLabel === filter.label}
            onClick={() => onQuickFilter(filter)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <input
        aria-label="Search receipts"
        type="search"
        value={search}
        disabled={duplicateMode}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search vendor, filename, amount, or receipt ID"
        className="text-control receipt-search"
      />
      {!duplicateMode && (
        <div className="receipt-filter-grid">
          <label className="field">
            <span className="field-label">From</span>
            <input
              aria-label="Receipt date from"
              type="date"
              className="text-control"
              value={filters.dateFrom ?? ''}
              onChange={(event) => update({ dateFrom: event.target.value || undefined })}
            />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input
              aria-label="Receipt date to"
              type="date"
              className="text-control"
              value={filters.dateTo ?? ''}
              onChange={(event) => update({ dateTo: event.target.value || undefined })}
            />
          </label>
          <label className="field">
            <span className="field-label">Document type</span>
            <input
              aria-label="Document type filter"
              className="text-control"
              value={filters.documentTypes?.[0] ?? ''}
              onChange={(event) => update({
                documentTypes: event.target.value.trim()
                  ? [event.target.value]
                  : undefined,
              })}
            />
          </label>
          <label className="field">
            <span className="field-label">Source</span>
            <Select
              label="Receipt source filter"
              value={filters.sourceKinds?.[0] ?? ''}
              onValueChange={(value) => update({
                sourceKinds: value
                  ? [value as NonNullable<ReceiptListParams['sourceKinds']>[number]]
                  : undefined,
              })}
              options={[{ value: '', label: 'All sources' },
                { value: 'WEB_UPLOAD', label: 'Web upload' },
                { value: 'API_UPLOAD', label: 'API upload' },
                { value: 'MCP_UPLOAD', label: 'MCP upload' }]}
            />
          </label>
          <label className="field">
            <span className="field-label">Match state</span>
            <Select
              label="Receipt match filter"
              value={filters.matched === undefined
                ? ''
                : filters.matched ? 'matched' : 'unmatched'}
              onValueChange={(value) => update({
                matched: value === ''
                  ? undefined
                  : value === 'matched',
              })}
              options={[{ value: '', label: 'All' },
                { value: 'matched', label: 'Matched' },
                { value: 'unmatched', label: 'Unmatched' }]}
            />
          </label>
          <label className="field field-checkbox">
            <input
              type="checkbox"
              className="checkbox-control"
              checked={filters.missingInfo ?? false}
              onChange={(event) => update({ missingInfo: event.target.checked })}
            />
            <span className="field-label">Missing information</span>
          </label>
        </div>
      )}
    </div>
  );
}

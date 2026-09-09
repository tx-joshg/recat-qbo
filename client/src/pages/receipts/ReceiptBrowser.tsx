import { Select } from '../../components/SelectCombobox';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ReceiptDto,
  ReceiptDuplicateGroupDto,
  ReceiptListParams,
} from '@recat/shared';
import {
  createCategorizationRequestId,
  receipts as receiptApi,
} from '../../lib/api';
import ReceiptFilters from '../../components/receipts/ReceiptFilters';
import ReceiptDropzone from '../../components/receipts/ReceiptDropzone';
import type { ReceiptQuickFilter } from '../../components/receipts/ReceiptFilters';
import ReceiptTable from '../../components/receipts/ReceiptTable';
import ReceiptSummary from '../../components/receipts/ReceiptSummary';
import { useApp } from '../../state/AppContext';

export default function ReceiptBrowser() {
  const { activeCompanyId, role, toast } = useApp();
  const [rows, setRows] = useState<ReceiptDto[]>([]);
  const [total, setTotal] = useState(0);
  const [duplicateGroups, setDuplicateGroups] = useState<ReceiptDuplicateGroupDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [quick, setQuick] = useState<ReceiptQuickFilter>({
    label: 'All',
    statuses: [],
  });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<NonNullable<ReceiptListParams['sortBy']>>('createdAt');
  const [sortOrder, setSortOrder] = useState<NonNullable<ReceiptListParams['sortOrder']>>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [advancedFilters, setAdvancedFilters] = useState<ReceiptListParams>({});
  const requestSequence = useRef(0);
  const mutable = role === 'admin' || role === 'categorizer';
  const pageSize = 20;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo<ReceiptListParams>(() => ({
    ...advancedFilters,
    statuses: quick.statuses,
    duplicate: quick.duplicate === true,
    search,
    page,
    pageSize,
    sortBy,
    sortOrder,
  }), [advancedFilters, page, quick, search, sortBy, sortOrder]);

  const load = useCallback(async () => {
    if (!activeCompanyId) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      if (quick.duplicate) {
        const groups = await receiptApi.duplicates(activeCompanyId);
        if (requestSequence.current !== sequence) return;
        const unique = new Map<string, ReceiptDto>();
        for (const group of groups) {
          for (const receipt of group.receipts) unique.set(receipt.id, receipt);
        }
        setDuplicateGroups(groups);
        setRows([...unique.values()]);
        setTotal(unique.size);
        return;
      }
      const result = await receiptApi.list(activeCompanyId, filters);
      if (requestSequence.current !== sequence) return;
      setDuplicateGroups([]);
      setRows(result.receipts);
      setTotal(result.total);
    } catch (error) {
      if (requestSequence.current === sequence) {
        toast(error instanceof Error ? error.message : 'Could not load receipts');
      }
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [activeCompanyId, filters, quick.duplicate, toast]);

  useEffect(() => {
    setRows([]);
    setSelected(new Set());
  }, [load]);

  useEffect(() => {
    requestSequence.current += 1;
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load, refreshRevision]);

  const polling = rows.some((receipt) =>
    receipt.status === 'QUEUED' || receipt.status === 'PROCESSING');
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => setRefreshRevision((value) => value + 1), 3_000);
    return () => window.clearInterval(timer);
  }, [load, polling]);

  const selectedRows = rows.filter((receipt) => selected.has(receipt.id));
  const body = {
    receipts: selectedRows.map((receipt) => ({
      id: receipt.id,
      expectedRevision: receipt.revision,
    })),
  };
  const mutate = async (
    label: string,
    operation: () => Promise<{ updated: number }>,
  ) => {
    if (!activeCompanyId || selectedRows.length === 0) return;
    setActing(true);
    try {
      const result = await operation();
      toast(`${result.updated} receipt${result.updated === 1 ? '' : 's'} ${label}`);
      setSelected(new Set());
      setRefreshRevision((value) => value + 1);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Receipt action failed');
    } finally {
      setActing(false);
    }
  };

  const exportSelected = async () => {
    if (!activeCompanyId || selectedRows.length === 0) return;
    setActing(true);
    try {
      const blob = await receiptApi.export(activeCompanyId, {
        documentIds: selectedRows.map((receipt) => receipt.id),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `recat-receipts-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Receipt export failed');
    } finally {
      setActing(false);
    }
  };

  if (!activeCompanyId) {
    return <div style={{ padding: 32 }}>Choose a company to browse receipts.</div>;
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <main className="receipt-browser" style={{ maxWidth: 1280, margin: '0 auto', padding: '28px clamp(14px,3vw,32px) 80px' }}>
      <h1 className="page-title" style={{ margin: 0 }}>Receipts</h1>
      <ReceiptSummary
        companyId={activeCompanyId}
        refreshKey={refreshRevision}
        toast={toast}
        uploadSection={(
          <section className="receipt-section" aria-labelledby="receipt-upload-title">
            <h2 id="receipt-upload-title" className="receipt-section-title">Add receipts</h2>
            <ReceiptDropzone
              disabled={!mutable || uploading}
              disabledLabel={!mutable
                ? 'Receipt uploads require categorizer access'
                : 'Uploading receipts…'}
              onFiles={(files) => {
                setUploading(true);
                receiptApi.upload(activeCompanyId, files, 'WEB_UPLOAD')
                  .then(() => {
                    toast(`${files.length} receipt${files.length === 1 ? '' : 's'} queued`);
                    setRefreshRevision((value) => value + 1);
                  })
                  .catch((error: unknown) => {
                    toast(error instanceof Error ? error.message : 'Receipt upload failed');
                  })
                  .finally(() => setUploading(false));
              }}
            />
          </section>
        )}
      />
      <section className="receipt-section receipt-filter-section" aria-labelledby="receipt-filter-title">
        <h2 id="receipt-filter-title" className="receipt-section-title">Filters</h2>
        <ReceiptFilters
          quickLabel={quick.label}
          search={searchInput}
          onQuickFilter={(filter) => {
            setQuick(filter);
            setPage(1);
            setSelected(new Set());
          }}
          onSearch={setSearchInput}
          filters={advancedFilters}
          duplicateMode={quick.duplicate === true}
          onFilters={(next) => {
            setAdvancedFilters(next);
            setPage(1);
            setSelected(new Set());
          }}
        />
      </section>
      {!quick.duplicate && selectedRows.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selected receipt actions"
          className="receipt-toolbar receipt-action-toolbar"
        >
          <span style={{ padding: '7px 0' }}>{selectedRows.length} selected</span>
          {mutable && <button
              type="button"
              className="btn btn-ghost"
              disabled={acting}
              onClick={() => void mutate('approved', () =>
                receiptApi.batchApprove(activeCompanyId, body))}
            >
              Approve selected
            </button>}
          {mutable && <button
              type="button"
              className="btn btn-ghost"
              disabled={acting}
              onClick={() => void mutate('queued', () =>
                receiptApi.batchReprocess(activeCompanyId, {
                  ...body,
                  idempotencyKey: createCategorizationRequestId(),
                }))}
            >
              Reprocess selected
            </button>}
          <button className="btn btn-ghost" type="button" disabled={acting} onClick={() => void exportSelected()}>
            Export selected
          </button>
          {mutable && <button
            type="button"
            className="btn btn-ghost"
            disabled={acting}
            onClick={() => void mutate('deleted', () =>
              receiptApi.batchDelete(activeCompanyId, body))}
          >
            Delete selected
          </button>}
        </div>
      )}
      {duplicateGroups.length > 0 && (
        <section aria-label="Duplicate receipt groups" style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 16 }}>Duplicate groups</h2>
          {duplicateGroups.map((group, index) => (
            <div key={group.key} style={{ marginBottom: 8 }}>
              <strong>Group {index + 1}</strong>{' '}
              <span style={{ color: 'var(--mut)' }}>
                {group.reason === 'content_hash'
                  ? 'same original file'
                  : 'same receipt identity'}
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {group.receipts.map((receipt) => (
                  <Link key={receipt.id} to={`/receipts/${receipt.id}`}>
                    {receipt.filename}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      {!quick.duplicate && <div className="receipt-toolbar receipt-sort-toolbar">
        <label className="field receipt-sort-field">
          <span className="field-label">Sort</span>
          <Select
            label="Sort receipts"
            value={sortBy}
            onValueChange={(value) => {
              setSortBy(value as typeof sortBy);
              setPage(1);
            }}
            options={[{ value: 'createdAt', label: 'Uploaded' },
              { value: 'receiptDate', label: 'Receipt date' },
              { value: 'vendorName', label: 'Vendor' },
              { value: 'totalAmount', label: 'Total' },
              { value: 'status', label: 'Status' }]}
          />
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Toggle sort direction"
          onClick={() => setSortOrder((value) => value === 'asc' ? 'desc' : 'asc')}
        >
          {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
        </button>
      </div>}
      {!quick.duplicate && <div aria-busy={loading}>
        <ReceiptTable
          receipts={rows}
          selected={selected}
          onSelect={(id, checked) => setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
          })}
          onSelectAll={(checked) => setSelected(
            checked ? new Set(rows.map((receipt) => receipt.id)) : new Set(),
          )}
        />
      </div>}
      {!quick.duplicate && <div className="receipt-toolbar receipt-pagination">
        <button className="btn btn-ghost" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
          Previous
        </button>
        <span>Page {page} of {pages}</span>
        <button className="btn btn-ghost" type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
          Next
        </button>
      </div>}
    </main>
  );
}

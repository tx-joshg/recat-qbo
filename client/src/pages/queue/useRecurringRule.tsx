import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuleMutationResult } from '@recat/shared';
import ConfirmDialog from '../../components/ConfirmDialog';
import { classificationMemory, createCategorizationRequestId, ruleOperations, rules } from '../../lib/api';

type Target = { companyId: string; transactionId: string; payee: string };
type Prompt = Target & {
  caseId: string;
  idempotencyKey: string | null;
  prepared: RuleMutationResult | null;
  busy: boolean;
};

/** Recurring intent is optional and starts only from a verified current case. */
export function useRecurringRule(activeCompanyId: string | null, toast: (message: string) => void) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const promptRef = useRef<Prompt | null>(null);
  const pendingCase = useRef<Target | null>(null);
  const generation = useRef(0);
  const scope = useRef(activeCompanyId);
  const mounted = useRef(true);
  if (scope.current !== activeCompanyId) {
    scope.current = activeCompanyId;
    generation.current += 1;
    promptRef.current = null;
    pendingCase.current = null;
  }
  const replace = useCallback((next: Prompt | null) => {
    promptRef.current = next;
    setPrompt(next);
  }, []);
  const dismiss = useCallback(() => {
    generation.current += 1;
    pendingCase.current = null;
    replace(null);
  }, [replace]);
  useEffect(() => { setPrompt(null); }, [activeCompanyId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  const invalidate = useCallback((transactionIds: string[]) => {
    const target = promptRef.current ?? pendingCase.current;
    if (target && transactionIds.includes(target.transactionId)) dismiss();
  }, [dismiss]);

  const offer = useCallback((target: Target) => {
    if (!mounted.current || scope.current !== target.companyId || promptRef.current || pendingCase.current) return;
    const request = ++generation.current;
    pendingCase.current = target;
    void classificationMemory.currentCase(target.companyId, target.transactionId).then(async value => {
      if (!mounted.current || generation.current !== request || scope.current !== target.companyId) return;
      if (!value || value.companyId !== target.companyId || value.transactionId !== target.transactionId || value.invalidatedAt !== null) {
        pendingCase.current = null;
        return;
      }
      const page = await rules.lifecycle(target.companyId, 'all', undefined, 1);
      if (!mounted.current || generation.current !== request || scope.current !== target.companyId) return;
      pendingCase.current = null;
      if (page.runtimeMode !== 'canonical') return;
      replace({ ...target, caseId: value.id, idempotencyKey: null, prepared: null, busy: false });
    }).catch(() => {
      if (generation.current === request) pendingCase.current = null;
      // CASE_NOT_FOUND and unavailable reads leave the verified result applied once.
    });
  }, [replace]);

  const prepare = useCallback(async () => {
    const current = promptRef.current;
    if (!current || current.busy || scope.current !== current.companyId) return;
    const request = generation.current;
    let idempotencyKey = current.idempotencyKey;
    replace({ ...current, busy: true });
    try {
      // New intent needs a current mode read; retries retain the exact existing operation.
      if (!idempotencyKey) {
        const page = await rules.lifecycle(current.companyId, 'all', undefined, 1);
        if (!mounted.current || generation.current !== request || scope.current !== current.companyId) return;
        if (page.runtimeMode !== 'canonical') {
          dismiss();
          toast('Rule changes are unavailable. This classification remains applied once.');
          return;
        }
        idempotencyKey = createCategorizationRequestId();
        replace({ ...current, idempotencyKey, busy: true });
      }
      const result = await ruleOperations.prepareFromCase(current.companyId, current.caseId, {
        matchText: current.payee, idempotencyKey,
      });
      if (!mounted.current || generation.current !== request || scope.current !== current.companyId) return;
      if (!result.ok || result.companyId !== current.companyId
        || result.mutation !== 'create' || result.originIntent !== 'make_recurring') {
        throw new Error(result.error?.message ?? 'Recurring suggestion could not be prepared.');
      }
      if (result.status === 'REPLAYED') {
        dismiss();
        toast('Recurring suggestion created — auto-post remains off');
        return;
      }
      if (result.status !== 'PREPARED' || !result.preview
        || result.preview.companyId !== current.companyId || result.preview.operationId !== result.operationId
        || result.preview.autoPost) throw new Error(result.error?.message ?? 'Recurring suggestion could not be prepared.');
      replace({ ...current, idempotencyKey, prepared: result, busy: false });
    } catch (error) {
      if (!mounted.current || generation.current !== request || scope.current !== current.companyId) return;
      replace({ ...current, idempotencyKey, busy: false });
      toast(error instanceof Error ? error.message : 'Recurring suggestion could not be prepared.');
    }
  }, [dismiss, replace, toast]);

  const commit = useCallback(async () => {
    const current = promptRef.current;
    if (!current?.prepared || !current.idempotencyKey || current.busy || scope.current !== current.companyId) return;
    const request = generation.current;
    replace({ ...current, busy: true });
    try {
      const result = await ruleOperations.commit(current.companyId, current.prepared.operationId, current.idempotencyKey);
      if (!mounted.current || generation.current !== request || scope.current !== current.companyId) return;
      if (!result.ok || result.companyId !== current.companyId || result.operationId !== current.prepared.operationId
        || !['COMMITTED', 'REPLAYED'].includes(result.status)) throw new Error(result.error?.message ?? 'Recurring suggestion was rejected.');
      dismiss();
      toast('Recurring suggestion created — auto-post remains off');
    } catch (error) {
      if (!mounted.current || generation.current !== request || scope.current !== current.companyId) return;
      replace({ ...current, busy: false });
      toast(error instanceof Error ? error.message : 'Recurring suggestion was rejected.');
    }
  }, [dismiss, replace, toast]);

  const visible = prompt?.companyId === activeCompanyId ? prompt : null;
  const content = <>
    {visible && !visible.prepared && <div role="status" style={{
      position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 24,
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
      background: 'var(--dark)', color: 'var(--darkInk)', borderRadius: 11,
      padding: '12px 18px', maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box',
    }}>
      <span>Verified classification for <strong>{visible.payee}</strong>.</span>
      <button className="btn-ghost" onClick={dismiss}>Apply once</button>
      <button className="btn-primary" onClick={() => void prepare()} disabled={visible.busy}>
        {visible.busy ? 'Preparing…' : 'Make recurring suggestion'}
      </button>
    </div>}
    <ConfirmDialog open={visible?.prepared?.preview != null} title="Make recurring suggestion?"
      confirmLabel="Confirm recurring suggestion" tone="primary" busy={visible?.busy ?? false}
      onConfirm={() => void commit()} onCancel={() => {
        const current = promptRef.current;
        if (current && !current.busy) replace({ ...current, prepared: null });
      }}>
      {visible?.prepared?.preview && <>
        <div>{visible.prepared.preview.condition.matchText} → {visible.prepared.preview.categoryName}
          {visible.prepared.preview.taxCodeName ? ` · ${visible.prepared.preview.taxCodeName}` : ''}</div>
        <div>{visible.prepared.preview.affectedPendingCount} pending · {visible.prepared.preview.affectedProcessedCount} processed</div>
        <div>Auto-post remains off. This creates a suggestion-only rule.</div>
      </>}
    </ConfirmDialog>
  </>;
  // The dialog owns Escape while reviewing or committing a prepared operation.
  const dismissOffer = useCallback(() => { if (!promptRef.current?.prepared) dismiss(); }, [dismiss]);
  return { offer, invalidate, dismiss: dismissOffer, content };
}

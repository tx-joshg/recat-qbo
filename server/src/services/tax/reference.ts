import type { Prisma, PrismaClient } from '@prisma/client';
import type { QboClient, QboTaxProfile } from '../../lib/qbo/types.js';

export const TAX_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TaxReferenceDeps {
  db: PrismaClient;
  getClient: (companyId: string) => Promise<QboClient>;
  now: () => Date;
}

async function defaultDeps(): Promise<TaxReferenceDeps> {
  const [{ prisma }, { qboFactory }] = await Promise.all([
    import('../../lib/prisma.js'),
    import('../../lib/qbo/factory.js'),
  ]);
  return { db: prisma, getClient: (companyId) => qboFactory.forCompany(companyId), now: () => new Date() };
}

export interface RefreshedTaxReference {
  profile: QboTaxProfile;
  status: 'unsupported' | 'needs_setup' | 'ready';
  reason: string | null;
  taxCodeCount: number;
  taxRateCount: number;
  refreshedAt: Date;
  cached: boolean;
}

function supportStatus(
  profile: QboTaxProfile,
  taxCodeCount: number,
): Pick<RefreshedTaxReference, 'status' | 'reason'> {
  if (profile.partnerTaxEnabled === true) {
    return {
      status: 'unsupported',
      reason: 'This company uses an automated tax model that Recat does not write yet.',
    };
  }
  if (!profile.usingSalesTax) {
    return { status: 'needs_setup', reason: 'Sales tax is not enabled in QuickBooks.' };
  }
  if (taxCodeCount === 0) {
    return { status: 'needs_setup', reason: 'QuickBooks has no purchase tax codes configured.' };
  }
  return { status: 'ready', reason: null };
}

/**
 * Refresh company-scoped QBO tax metadata. TaxCode/TaxRate do not participate
 * in CDC, so this owns an explicit TTL and is also callable with force=true
 * from Settings and immediately before a tax-bearing write.
 */
export async function refreshTaxReference(
  companyId: string,
  opts: { force?: boolean } = {},
  deps?: TaxReferenceDeps,
): Promise<RefreshedTaxReference> {
  const d = deps ?? (await defaultDeps());
  const company = await d.db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);
  const now = d.now();
  if (
    !opts.force &&
    company.taxReferenceRefreshedAt !== null &&
    now.getTime() - company.taxReferenceRefreshedAt.getTime() < TAX_REFERENCE_TTL_MS
  ) {
    const [taxCodeCount, taxRateCount] = await Promise.all([
      d.db.qboTaxCode.count({ where: { companyId } }),
      d.db.qboTaxRate.count({ where: { companyId } }),
    ]);
    const profile = {
      usingSalesTax: company.taxUsingSalesTax ?? taxCodeCount > 0,
      partnerTaxEnabled: null,
      raw: null,
    };
    return {
      profile,
      status: company.taxSupportStatus as RefreshedTaxReference['status'],
      reason: company.taxSupportReason,
      taxCodeCount,
      taxRateCount,
      refreshedAt: company.taxReferenceRefreshedAt,
      cached: true,
    };
  }

  const client = await d.getClient(companyId);
  const [profile, taxCodes, taxRates] = await Promise.all([
    client.getTaxProfile(),
    client.listTaxCodes(),
    client.listTaxRates(),
  ]);
  const rateIds = new Set(taxRates.map((rate) => rate.qboId));
  for (const code of taxCodes) {
    for (const detail of [...code.purchaseTaxRateList, ...code.salesTaxRateList]) {
      if (!rateIds.has(detail.taxRateQboId)) {
        throw new Error(
          `QuickBooks TaxCode ${code.qboId} references unknown TaxRate ${detail.taxRateQboId}; tax cache not updated.`,
        );
      }
    }
  }
  const support = supportStatus(profile, taxCodes.length);

  await d.db.$transaction(async (tx) => {
    for (const rate of taxRates) {
      const data = {
        name: rate.name,
        description: rate.description ?? null,
        active: rate.active,
        rateValue: rate.rateValue,
        rawData: rate.raw as Prisma.InputJsonValue,
      };
      await tx.qboTaxRate.upsert({
        where: { companyId_qboId: { companyId, qboId: rate.qboId } },
        create: { companyId, qboId: rate.qboId, ...data },
        update: data,
      });
    }
    for (const code of taxCodes) {
      const data = {
        name: code.name,
        description: code.description ?? null,
        active: code.active,
        taxable: code.taxable,
        purchaseTaxRateList: code.purchaseTaxRateList as unknown as Prisma.InputJsonValue,
        salesTaxRateList: code.salesTaxRateList as unknown as Prisma.InputJsonValue,
        rawData: code.raw as Prisma.InputJsonValue,
      };
      await tx.qboTaxCode.upsert({
        where: { companyId_qboId: { companyId, qboId: code.qboId } },
        create: { companyId, qboId: code.qboId, ...data },
        update: data,
      });
    }
    await tx.qboTaxCode.updateMany({
      where: { companyId, qboId: { notIn: taxCodes.map((code) => code.qboId) } },
      data: { active: false },
    });
    await tx.qboTaxRate.updateMany({
      where: { companyId, qboId: { notIn: taxRates.map((rate) => rate.qboId) } },
      data: { active: false },
    });
    await tx.company.update({
      where: { id: companyId },
      data: {
        taxReferenceRefreshedAt: now,
        taxUsingSalesTax: profile.usingSalesTax,
        taxSupportStatus: support.status,
        taxSupportReason: support.reason,
      },
    });
  });

  return {
    profile,
    ...support,
    taxCodeCount: taxCodes.length,
    taxRateCount: taxRates.length,
    refreshedAt: now,
    cached: false,
  };
}

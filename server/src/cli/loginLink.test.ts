import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runLoginLink, type LoginLinkDependencies } from './loginLink.js';

const USER = { id: 'u1', email: 'admin@example.com' };

function dependencies(overrides: Partial<LoginLinkDependencies> = {}): LoginLinkDependencies {
  return {
    findUser: vi.fn(async () => USER),
    issueLink: vi.fn(async () => ({ link: 'https://recat.test/auth/callback?token=fresh' })),
    writeOut: vi.fn(),
    writeError: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('runLoginLink', () => {
  it('normalizes the email, issues one link, prints it, and disconnects', async () => {
    const deps = dependencies();

    const code = await runLoginLink(['  ADMIN@Example.COM  '], deps);

    expect(code).toBe(0);
    expect(deps.findUser).toHaveBeenCalledWith('admin@example.com');
    expect(deps.issueLink).toHaveBeenCalledWith(USER);
    expect(deps.writeOut).toHaveBeenCalledWith(expect.stringContaining('admin@example.com'));
    expect(deps.writeOut).toHaveBeenCalledWith(expect.stringContaining('expires in 15 minutes'));
    expect(deps.writeOut).toHaveBeenCalledWith(expect.stringContaining('token=fresh'));
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { args: [], label: 'missing argument' },
    { args: ['one@example.com', 'two@example.com'], label: 'extra argument' },
    { args: ['not-an-email'], label: 'invalid email' },
  ])('returns usage failure for $label and still disconnects', async ({ args }) => {
    const deps = dependencies();

    expect(await runLoginLink(args, deps)).toBe(2);
    expect(deps.issueLink).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalled();
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it('fails without creating a user when the email is unknown', async () => {
    const deps = dependencies({ findUser: vi.fn(async () => null) });

    expect(await runLoginLink(['missing@example.com'], deps)).toBe(1);
    expect(deps.issueLink).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalledWith('No Recat user exists with that email.');
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it('reports token creation failure without leaking a partial link', async () => {
    const deps = dependencies({ issueLink: vi.fn(async () => { throw new Error('database offline'); }) });

    expect(await runLoginLink(['admin@example.com'], deps)).toBe(1);
    expect(deps.writeOut).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalledWith('Could not create login link: database offline');
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it('reports lookup failure and still disconnects', async () => {
    const deps = dependencies({ findUser: vi.fn(async () => { throw new Error('database offline'); }) });

    expect(await runLoginLink(['admin@example.com'], deps)).toBe(1);
    expect(deps.writeOut).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalledWith('Could not create login link: database offline');
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it('turns disconnect failure into a nonzero exit', async () => {
    const deps = dependencies({ disconnect: vi.fn(async () => { throw new Error('disconnect failed'); }) });

    expect(await runLoginLink(['admin@example.com'], deps)).toBe(1);
    expect(deps.writeError).toHaveBeenCalledWith('Could not close database connection: disconnect failed');
  });
});

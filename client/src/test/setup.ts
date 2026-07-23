import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import type matchers from '@testing-library/jest-dom/matchers';
import { afterEach } from 'vitest';

declare module 'vitest' {
  interface Assertion<T = any> extends matchers.TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends matchers.TestingLibraryMatchers<any, any> {}
}

afterEach(cleanup);

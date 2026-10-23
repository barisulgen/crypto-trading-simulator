import { describe, expect, it } from 'vitest';
import { ErrorBoundary, FALLBACK_TEXT } from '../src/components/ErrorBoundary.tsx';

// The project has no DOM renderer, so the boundary's state logic is tested directly.
describe('ErrorBoundary', () => {
  it('a thrown child switches the state to failed', () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('shows the fallback text instead of an empty root once failed, the children before', () => {
    const b = new ErrorBoundary({ children: 'child' });
    expect(b.render()).toBe('child');
    b.state = { failed: true };
    expect(JSON.stringify(b.render())).toContain(FALLBACK_TEXT);
    expect(FALLBACK_TEXT).toBe('Something went wrong displaying this screen');
  });
});

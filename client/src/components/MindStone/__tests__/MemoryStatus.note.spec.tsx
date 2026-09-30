import { render, screen } from '@testing-library/react';
import SystemStatus, { MemoryStatus } from '../SystemStatus';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key} ${JSON.stringify(args)}` : key,
}));

const noExtension = {
  present: true,
  sqliteVec: { available: false, error: 'no such function: vec_version' },
};

describe('the sqlite-vec extension missing (#53)', () => {
  it('is a note, not a problem, when built-in vector search is working', () => {
    render(<MemoryStatus memory={{ sqlite: { ...noExtension, vectorBackend: 'js-cosine' } }} />);
    const note = screen.getByText('com_mindstone_sys_sqlite_vec_note');
    expect(note).toHaveClass('text-text-secondary');
    expect(screen.queryByText(/vec_version/)).toBeNull();
  });

  it("doesn't count toward the system status's problems", () => {
    render(
      <SystemStatus
        system={{ ok: true, memory: { sqlite: { ...noExtension, vectorBackend: 'js-cosine' } } }}
      />,
    );
    expect(screen.getByTestId('ms-system-overall')).toHaveTextContent('com_mindstone_sys_ok');
  });

  it('is still a warning when search has no vectors at all', () => {
    render(<MemoryStatus memory={{ sqlite: { ...noExtension, vectorBackend: 'lexical' } }} />);
    expect(screen.getByText(/com_mindstone_sys_sqlite_vec .*vec_version/)).toHaveClass(
      'text-orange-500',
    );
  });
});

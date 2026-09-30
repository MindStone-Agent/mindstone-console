import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MindStoneSection, { MINDSTONE_PAGES } from '../MindStoneSection';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const mockSetSidebarOpen = jest.fn();
jest.mock('~/hooks/Nav/useSidebarToggle', () => () => ({ setSidebarOpen: mockSetSidebarOpen }));
let mockSmall = false;
jest.mock('@librechat/client', () => ({ useMediaQuery: () => mockSmall }));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MindStoneSection />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MindStone sidebar section (#53)', () => {
  afterEach(() => {
    mockSetSidebarOpen.mockReset();
    mockSmall = false;
  });

  it('links to every MindStone page, Memory included', () => {
    renderAt('/c/new');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(MINDSTONE_PAGES.map((page) => page.to));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/mindstone/personas',
        '/mindstone/skills',
        '/mindstone/memory',
        '/mindstone/approvals',
        '/mindstone',
      ]),
    );
  });

  it('goes to the page on a click, from the chat page', () => {
    renderAt('/c/new');
    fireEvent.click(screen.getByTestId('mindstone-nav-personas'));
    expect(screen.getByTestId('where')).toHaveTextContent('/mindstone/personas');
  });

  it('marks the page you are on', () => {
    renderAt('/mindstone/memory');
    expect(screen.getByTestId('mindstone-nav-memory')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('mindstone-nav-skills')).not.toHaveAttribute('aria-current');
  });

  it('closes the sidebar first on a phone, then goes', () => {
    mockSmall = true;
    renderAt('/c/new');
    fireEvent.click(screen.getByTestId('mindstone-nav-skills'));
    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false, expect.any(Function));
    const afterSlide = mockSetSidebarOpen.mock.calls[0][1] as () => void;
    act(() => afterSlide());
    expect(screen.getByTestId('where')).toHaveTextContent('/mindstone/skills');
  });

  it('leaves a modified click to the browser (a new tab)', () => {
    renderAt('/c/new');
    fireEvent.click(screen.getByTestId('mindstone-nav-skills'), { metaKey: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/c/new');
  });
});

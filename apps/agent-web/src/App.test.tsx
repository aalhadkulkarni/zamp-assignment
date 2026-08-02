import { render, screen } from '@testing-library/react';
import App from './App';

it('renders the app heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'zamp-assignment' })).toBeInTheDocument();
});
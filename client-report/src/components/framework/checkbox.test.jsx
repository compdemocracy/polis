import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Checkbox from './checkbox';
import settings from '../../settings'; // Assuming settings is imported correctly

import '@testing-library/jest-dom';

describe('Checkbox Component', () => {
  it('renders checkbox with correct initial state and styles', () => {
    const label = 'Test Label';
    const isChecked = true;
    const color = 'blue'; // Override default color

    render(<Checkbox label={label} isChecked={isChecked} color={color} />);

    const checkbox = screen.getByTestId('checkbox');
    const labelText = screen.getByText(label);

    expect(checkbox).toHaveStyle({ backgroundColor: color });
  });

  it('toggles checkbox state and calls clickHandler on click', () => {
    const label = 'Test Label';
    const isChecked = false;
    const mockClickHandler = jest.fn();

    render(<Checkbox label={label} isChecked={isChecked} clickHandler={mockClickHandler} />);

    const checkbox = screen.getByRole('checkbox');

    fireEvent.click(checkbox);


    expect(mockClickHandler).toHaveBeenCalledTimes(1);
    expect(mockClickHandler).toHaveBeenCalledWith(true); // New state after click
  });

  it('shows help text if provided', () => {
    const label = 'Test Label';
    const isChecked = true;
    const helpText = 'This is some help text';

    render(<Checkbox label={label} isChecked={isChecked} helpText={helpText} />);

    const helpTextElement = screen.getByText(/This is some help text/);

    expect(helpTextElement).toBeInTheDocument();
  });

  it('hides help text if not provided', () => {
    const label = 'Test Label';
    const isChecked = true;

    render(<Checkbox label={label} isChecked={isChecked} />);

    const helpTextElement = screen.queryByText(/help text/i); // Use queryByText for potential absence

    expect(helpTextElement).not.toBeInTheDocument();
  });

});
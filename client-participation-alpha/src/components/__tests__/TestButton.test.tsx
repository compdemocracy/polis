import { render, screen, fireEvent } from '@testing-library/react'
import TestButton from '../TestButton'

describe('TestButton', () => {
  it('should render button with label', () => {
    render(<TestButton label="Click me" />)

    const button = screen.getByRole('button', { name: 'Click me' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Click me')
  })

  it('should handle click events', () => {
    const handleClick = jest.fn()
    render(<TestButton label="Test" onClick={handleClick} />)

    const button = screen.getByRole('button', { name: 'Test' })
    fireEvent.click(button)

    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('should be disabled when disabled prop is true', () => {
    render(<TestButton label="Disabled" disabled={true} />)

    const button = screen.getByRole('button', { name: 'Disabled' })
    expect(button).toBeDisabled()
  })

  it('should not be disabled by default', () => {
    render(<TestButton label="Enabled" />)

    const button = screen.getByRole('button', { name: 'Enabled' })
    expect(button).not.toBeDisabled()
  })

  it('should not call onClick when disabled', () => {
    const handleClick = jest.fn()
    render(<TestButton label="Test" onClick={handleClick} disabled={true} />)

    const button = screen.getByRole('button', { name: 'Test' })
    fireEvent.click(button)

    expect(handleClick).not.toHaveBeenCalled()
  })

  it('should apply custom className', () => {
    render(<TestButton label="Custom" className="custom-class" />)

    const button = screen.getByRole('button', { name: 'Custom' })
    expect(button).toHaveClass('test-button')
    expect(button).toHaveClass('custom-class')
  })

  it('should apply default className when no custom class provided', () => {
    render(<TestButton label="Default" />)

    const button = screen.getByRole('button', { name: 'Default' })
    expect(button).toHaveClass('test-button')
    expect(button.className).toBe('test-button ')
  })

  it('should have aria-label matching the label prop', () => {
    render(<TestButton label="Accessible Button" />)

    const button = screen.getByRole('button', { name: 'Accessible Button' })
    expect(button).toHaveAttribute('aria-label', 'Accessible Button')
  })

  it('should render with different labels', () => {
    const { rerender } = render(<TestButton label="First" />)

    expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument()

    rerender(<TestButton label="Second" />)
    expect(screen.getByRole('button', { name: 'Second' })).toBeInTheDocument()
  })

  it('should handle multiple rapid clicks', () => {
    const handleClick = jest.fn()
    render(<TestButton label="Multi-click" onClick={handleClick} />)

    const button = screen.getByRole('button', { name: 'Multi-click' })

    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(handleClick).toHaveBeenCalledTimes(3)
  })
})

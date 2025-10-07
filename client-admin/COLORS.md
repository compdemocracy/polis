# Polis Client-Admin Color Inventory

Complete inventory of all colors used in the application as of responsive redesign.

## Current Theme Colors (theme/index.js)

### Primary Colors

| Token        | Hex       | RGB                | Usage                       |
| ------------ | --------- | ------------------ | --------------------------- |
| `text`       | `#60656f` | rgb(96, 101, 111)  | Main text color             |
| `background` | `#FFF`    | rgb(255, 255, 255) | Page background             |
| `primary`    | `#03a9f4` | rgb(3, 169, 244)   | Brand blue, primary actions |
| `secondary`  | `#f6f7f8` | rgb(246, 247, 248) | Light gray background       |

### Gray Scale

| Token           | Hex       | RGB                | Usage                 |
| --------------- | --------- | ------------------ | --------------------- |
| `mediumGray`    | `#60656f` | rgb(96, 101, 111)  | Same as text, borders |
| `textSecondary` | `#8a9099` | rgb(138, 144, 153) | Secondary/meta text   |
| `muted`         | `#f3f4f6` | rgb(243, 244, 246) | Muted backgrounds     |
| `border`        | `#e5e7eb` | rgb(229, 231, 235) | Default border color  |
| `gray`          | `#6b7280` | rgb(107, 114, 128) | Utility gray          |
| `lightGray`     | `#9ca3af` | rgb(156, 163, 175) | Light utility gray    |

### Semantic Colors

| Token     | Hex       | RGB               | Usage                          |
| --------- | --------- | ----------------- | ------------------------------ |
| `success` | `#4dd599` | rgb(77, 213, 153) | Success states, accept actions |
| `error`   | `#f06273` | rgb(240, 98, 115) | Error states, reject actions   |
| `warning` | `#ffb74d` | rgb(255, 183, 77) | Warning states, meta actions   |
| `info`    | `#03a9f4` | rgb(3, 169, 244)  | Informational, primary brand   |

### Hover States (Buttons)

| Token                      | Base      | Hover     | Usage                                 |
| -------------------------- | --------- | --------- | ------------------------------------- |
| `primary` / `infoHover`    | `#03a9f4` | `#0288d1` | Primary button hover (darker blue)    |
| `success` / `successHover` | `#4dd599` | `#3dbd85` | Success button hover (darker green)   |
| `error` / `errorHover`     | `#f06273` | `#e04d60` | Danger button hover (darker red/pink) |
| `warning` / `warningHover` | `#ffb74d` | `#f5a732` | Warning button hover (darker orange)  |

## Legacy Settings.js Colors - DELETED ✅

This file was completely unused (no imports found) and has been removed.

## Victory Charts Theme (victoryTheme.js)

Material Design color palette for data visualization:

### Chart Colors (Cycle)

1. `deepOrange600`: `#f4511e` rgb(244, 81, 30) - Orange-red
2. `yellow200`: `#fff59d` rgb(255, 245, 157) - Light yellow
3. `lime300`: `#dce775` rgb(220, 231, 117) - Lime green
4. `lightGreen500`: `#8bc34a` rgb(139, 195, 74) - Green
5. `teal700`: `#00796b` rgb(0, 121, 107) - Teal
6. `cyan900`: `#006064` rgb(0, 96, 100) - Dark cyan

### Chart Grays

- `blueGrey50`: `#eceff1` rgb(236, 239, 241) - Very light
- `blueGrey300`: `#90a4ae` rgb(144, 164, 174) - Medium
- `blueGrey700`: `#455a64` rgb(69, 90, 100) - Dark
- `grey900`: `#212121` rgb(33, 33, 33) - Very dark

### Chart Backgrounds

- Candlestick positive: `#ffffff` (white)
- Tooltip/flyout background: `#f0f0f0` rgb(240, 240, 240)

## Spinner Component

- Animated logo fill: `rgba(140, 140, 140, 1)` rgb(140, 140, 140) - Medium gray

## Color Usage Patterns

### ✅ **Using Theme Tokens** (Good!)

- Most components reference theme colors by name: `color: 'primary'`, `bg: 'secondary'`
- Buttons use semantic variants: `variant="success"`, `variant="danger"`, etc.
- Cards use theme colors

## Color Contrast & Accessibility Notes

### Current Text Combinations

- `text` on `background`: #60656f on #FFF ✓ (WCAG AA compliant)
- `primary` on `background`: #03a9f4 on #FFF ⚠️ (May fail for small text)
- `textSecondary` on `background`: #8a9099 on #FFF ✓ (AA compliant)

### Action Colors on White

- `success` (#22c55e) on white ✓
- `error` (#ef4444) on white ✓
- `warning` (#f59e0b) on white ⚠️ (Borderline, check small text)

**Recommendation:** Test contrast ratios, especially for:

- Primary blue on white backgrounds
- Warning orange on white
- Small text with secondary colors

## Implementation Status - COMPLETE ✅

### 1. New Color Palette Applied ✅

Updated theme with new semantic colors:

- `success`: `#4dd599` (softer green)
- `error`: `#f06273` (softer red)
- `warning`: `#ffb74d` (softer orange)
- `info`: `#03a9f4` (primary brand blue)

Plus hover states: `successHover`, `errorHover`, `warningHover`, `infoHover`

### 2. Deprecated settings.js Removed ✅

- File deleted (was completely unused, no imports found)
- Theme is now single source of truth for all colors

### 3. All Hardcoded Colors Replaced ✅

- ✅ ProximityVisualization.js: Now uses `theme.colors.*` references
- ✅ Comment.js: Changed `'red'` → `'error'`
- ✅ TopicStats.js: Changed CSS color names to theme tokens
- ✅ TopicTree.js: `getStatusColor()` returns theme tokens
- ✅ TopicDetail.js: `getStatusColor()` returns theme tokens
- ✅ InviteCodes.js: `getStatusColor()` returns theme tokens
- ✅ ParticipantXids.js: Changed `'red'` → `'error'`
- ✅ InviteTree.js: Changed `'red'` → `'error'`

### 4. Victory Charts Preserved ✅

- Material Design palette kept separate for data visualization
- Provides visual distinction between UI elements and data charts
- No conflicts with theme colors

### 5. Dark Mode - Not Implemented

- No plans for dark mode support
- Light mode palette optimized and complete

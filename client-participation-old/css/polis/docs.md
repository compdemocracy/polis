# Polis Style Guide

## Modular CSS

### Base

  * `/base` styles are the foundation of the site, which include:
  ** `_base` - styles are applied directly to element using an element selector
  ** `_utilities` - not reflective of application state
  ** `_variables` - site-wide variables such as fonts, colors, widths, etc.
  ** `_content` - universal text and content styles reside here

### Layout

  * `/layout` determine how sections of the page are structured.

### Modules

  * `/modules` contain discrete components of the page, such as navigation, alert dialogs, buttons, etc. Any new feature or component will be added to this section.

### States

  * `/states` augment and override all other styles, such as whether an element is expanded or collapsed, or if the element is in an error or active state.

#### Distinguishing states and modifiers

A state should be prefixed with `.is-` and reflects a state on the component itself (`.is-active`, `.is-expanded`).

A modifier should be prefixed with `.has-` and generally reflects a state on the child of a component usually the existence of a modifier is kind of circumstantial. The child element has its own state that for styling purposes requires additional styles on the parent. E.g. `.has-expanded-sidebar`

## SUIT-flavored BEM

BEM, meaning _block, element, modifier_, provides meaningful and easy to parse naming conventions that make your CSS easy to understand. It helps you write more maintainable CSS to think in those terms as well.

[SUIT-flavored BEM](http://nicolasgallagher.com/about-html-semantics-front-end-architecture/) is just a slightly nicer looking version of BEM, as used by Nicolas Gallagher's (creator of Normalize.css) [SUIT framework](https://github.com/suitcss/suit). It looks like this:

```scss
/* Utility */
.u-utilityName {}

/* Component */
.ComponentName {}

/* Component modifier */
.ComponentName--modifierName {}

/* Component descendant */
.ComponentName-descendant {}

/* Component descendant modifier */
.ComponentName-descendant--modifierName {}

/* Component state (scoped to component) */
.ComponentName.is-stateOfComponent {}
```

Note the camelCasing! It looks crazy at first, but it's really pretty pleasant. (It also maps really well to Components/Views).

The resulting HTML would look like this:

```html
<div class="ComponentName">
  <p class="ComponentName-descendant">…</p>
</div>

<div class="ComponentName ComponentName--modifierName">
  <p class="ComponentName-descendant ComponentName-descendant--modifierName">…</p>
</div>
```

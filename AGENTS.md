# Website maintenance scope

- Backend maintenance must preserve all existing frontend behavior and content.
- Do not modify page layout, browser JavaScript, styling, images, navigation,
  carousels, scrolling, or animations unless the user explicitly authorizes that
  frontend change. Cache tokens may be updated when restoring existing behavior.
- Preserve the homepage research carousel: the lab introduction and all six
  research slides must remain available and rotate automatically as before.
- Check actual carousel rotation on desktop and mobile; static screenshots and
  tests with reduced motion enabled are insufficient to verify autoplay.
- Keep temporary files under the exported `$TMPDIR`; never use `/tmp`.

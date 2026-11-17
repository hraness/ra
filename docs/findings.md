# Findings

Every finding is a sentence: what is wrong, which element, and by how much. Each one carries a `kind`, a `message`, a short description of the element (`where`) and a CSS selector for it (`selector`); `--json` prints all four.

ra's first duty is to stay quiet on pages that are fine. Each check below lists what it deliberately leaves alone. A false alarm on a correct page is a bug in ra: please report it with the smallest page that shows it.

`ra check` folds the same finding at several views into one line and names the views only when it does not show at all of them: `[phone, phone.dark]`.

## Layout

### `page-scroll`

The page scrolls sideways at this view. The message names up to three elements that stick out past the right edge, with how far.

- Measured against the layout viewport, so a touch view that zooms out to fit a too-wide page is still caught.
- Fixed-position elements are not blamed.
- Not reported when `ra look --in` narrows the look to part of the page.

### `cut-off`

Text or a control is clipped by a box with `overflow: hidden` or `clip`, so part of it cannot be seen or reached.

- Left alone: an ellipsis (`text-overflow` other than `clip`) and a line clamp (`-webkit-line-clamp`), which are clipping on purpose.
- Left alone: anything inside a box that scrolls, since it can be scrolled into view.
- Left alone: screen-reader-only text (tiny and clipped, or `clip-path: inset(50%)`).

### `spill`

Text runs out of its box: past the right or left edge, or below the bottom, without being clipped. Usually a long word, a fixed height, or a flex child that cannot shrink.

- Left alone: text inside a box that scrolls or hides its overflow between the text and the box; clipping there is `cut-off`'s business.

### `overlap`

Two pieces of text are painted on top of each other in the same layer.

- Text on a different surface does not count: inside an absolutely positioned, fixed or transformed box, or a box with its own background. Neither does text nested inside the other.
- At most five pairs are reported per look.

### `covered`

Something sits over the centre of a control, so a click or tap there would land on that instead. ra hit-tests each control in view while it scrolls through the page.

- Left alone: a label covering its own input; checkbox, radio, file and range inputs, which custom controls often draw over on purpose; and controls that are nearly transparent.
- An overlay is named as a whole, not by the paragraph inside it that happened to be hit.

## Reading and reaching

### `contrast`

Text is too pale against what is really behind it, by the WCAG AA ratios: 4.5:1, or 3:1 for large text (24px, or 18.66px bold).

ra photographs the page twice, once as it is and once with every glyph made transparent. The second picture is the true background under each line of text, whatever painted it: a gradient, a photo, an overlay or a blend. Contrast is computed from those pixels, so it is right where CSS-based checkers have to guess.

### `small-target`

On touch views, a control is smaller than `tapTarget` (24px by default) **and** another control is close enough to hit by mistake.

- Left alone: a small control with room around it, and a link inside a sentence, which is as tall as its line.

### `no-name`

A control has no accessible name, or an image has no `alt` attribute.

- Images with `alt=""`, `role="presentation"` or inside `aria-hidden="true"` are decoration and are fine.
- Controls that render through a shadow root or a slot are not judged, since their name may live there.

## Content

### `image`

An image did not load, or is shown at a different aspect ratio from its own (more than 8% off) with `object-fit: fill`. SVGs and images smaller than 24px are not checked for stretching.

### `blank`

Nothing is visible: no text, picture or control.

### `document`

The page has no title. On touch views, the page has no `<meta name="viewport">`. Or the response status is 400 or higher, or not the `status` the state says it should have.

### `error-overlay`

A Vite, Next.js or webpack dev-server error overlay is showing, with its message.

## Behaviour

### `console`

The console logged an error, or an exception went uncaught. Repeats are counted.

### `request`

A request failed or answered 4xx/5xx. An error the world was told to give is the state you asked for, not a finding. A reply function that throws is one, since the world itself is broken; the page gets a 500 and the message carries the error. So is a reply for an address that the page reaches only through a redirect: the browser follows redirects by itself and never asks for it. Give the reply to the address that redirects. Against a deployment no reply stands in for the deployment's own paths, so there the message suggests blocking that address instead.

### `outside`

A request left the app and nothing in the world answers it. The page asked an outside host for something, a redirect tried to leave, or the app's server asked one of its upstream stand-ins for something with no reply. The message says which host to give a reply, or to list under `allow` or `block`.

For a redirect, the message names the address that redirected, because that is the one a reply can answer. ra stops a redirect by its host, so some hops go through: to an allowed host at an address its rule leaves out, to a path on the app that is under `block`, or to a host that only another state allows, since the states of a run share one browser. The message then says that the request went through, and why. A hop counts as stopped only when the closed world stopped it, since the browser lets through only the app's own address and the hosts the run allows; one it let through that then failed, such as at a port where nothing listens, is reported as going through. On a deployment, a redirect to the same site at another address, on https or with or without `www.`, is stopped like any other, and the message says to look at that address instead. Hops that went through are reported first, apart from the ones that were stopped.

### `load`

The page did not load: a network error, a timeout, or a navigation the closed world stopped. When a redirect of the page failed, the message says where it led: to a host the world blocks, to an address whose reply the browser could not use (the `request` finding says more), outside the world (the `outside` finding says more), or to the same site at another address, which it says to look at instead. A redirect that the world let through and that failed by itself is reported as failing.

### `busy`

Requests were still open when the settle time ran out (5 seconds by default). Usually a long poll, a stream or a request that never answers. Give it a reply in the world, or block it.

### `expect` and `steps`

A state's `ready` selector never showed, a `see` text is not visible, its `expect` threw, or the `--in` selector matched nothing (`expect`). Its `steps` threw, or the `--then` code threw (`steps`). These are your own checks, and the message carries your error.

## Accepting a finding

Some findings are true and fine: a decorative hero whose text is tested by hand, a third-party widget you cannot change. Accept them in the config with a reason:

```ts
accept: [
  { finding: "contrast", match: "hero", why: "The hero sits on a photo; checked by hand per release." },
  { finding: "console", match: /ResizeObserver loop/u, why: "Chromium noise from a library we do not control." },
],
```

`match` is text or a pattern the finding's message or element must contain. Without it, every finding of that kind is accepted, which is rarely what you want. Accepted findings still print, with their reason, but do not fail `ra check`. When every state is checked, `ra check` names the accept entries that matched nothing, so they do not outlive the problem.

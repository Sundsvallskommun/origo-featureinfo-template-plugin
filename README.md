# origo-featureinfo-template-plugin

Origo plugin for **configurable infowindow templates**. Allows you to register your own
featureinfo templates - including code that is executed only when the template's HTML is in
the DOM - without changing anything in Origo's core.

Requires **Origo 2.10.0** or later. No other dependencies, no build step -
a single file.

## Why

A featureinfo template in Origo returns an HTML string that Origo writes in with
`innerHTML`. This is sufficient for static content, but not when the content is to be
drawn by other code: diagrams, maps, 3D views, calculations. Such code must be executed
_after_ the element is in the document, and `innerHTML` does not execute any `<script>`.

## Installation

Add `featureinfo-template.js` to the `plugins/` web root and load it after
`origo.js`:

```html
<script src="js/origo.js"></script>
<script src="plugins/featureinfo-template.js"></script>
```

## Use

```html
<script>
  var origo = Origo("index.json");

  origo.on("load", function (viewer) {
    viewer.addComponent(
      Featureinfotemplate({
        templates: [
          {
            name: "solay",
            containerId: "solkartan-popup",
            html: '<div id="{{containerId}}"></div>',
            onVisible: "solkartan.render_popup",
            onVisibleArgs: ["{{attributes}}", "{{containerId}}", "data/3d"],
          },
        ],
      }),
    );
  });
</script>
```

Then attach the template to a layer in `index.json`, either for the entire layer:

```json
{
  "name": "min:lagerNamn",
  "queryable": true,
  "attributes": "solay"
}
```

or for a single attribute:

```json
{
  "name": "min:lagerNamn",
  "queryable": true,
  "attributes": [{ "name": "namn", "title": "Namn: " }, { "template": "solay" }]
}
```

## Alternative

### `templates[]`

| Options         | Type                 | Default                                            | Description                                                                                  |
| --------------- | -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `name`          | `string`             | _(required)_                                       | Name of the template. Matches the layer's `attributes` string or an attribute's `template`.  |
| `html`          | `string`             | `<div id="{{containerId}}"></div>`                 | HTML template with `{{placeholder}}`.                                                        |
| `render`        | `function`           | -                                                  | `(attributes, layer, containerId) => string`. Takes precedence over `html`.                  |
| `containerId`   | `string`             | `<name>-container`                                 | Base id of the container.                                                                    |
| `unique`        | `boolean`            | `true`                                             | Add a sequential number to the id so that multiple concurrent features don't clash.          |
| `onVisible`     | `string \| function` | -                                                  | Runs when the container is in the DOM. String is interpreted as a path to a global function. |
| `onVisibleArgs` | `array`              | `['{{container}}', '{{attributes}}', '{{layer}}']` | Arguments to the callback.                                                                   |

### Top level

| Options          | Type     | Default | Description                                                                                      |
| ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `templates`      | `array`  | `[]`    | Templates to register.                                                                           |
| `pendingTimeout` | `number` | `10000` | How long (ms) the plugin waits for a container to appear in the DOM before the job is discarded. |

## Placeholders

In `html`, replace:

- `{{containerId}}` - the container's id.

- `{{optional_attributename}}` - the feature's attribute value, HTML-escaped. Unknown
  names will be an empty string.

In `onVisibleArgs`, an argument that is _exactly_ one of these is exchanged for the value
itself (not a string):

- `{{attributes}}` - the feature's attributes as objects.
- `{{container}}` - the container's DOM element.
- `{{containerId}}` - the container's id as a string.
- `{{layer}}` - the OpenLayers layer.

Other arguments are passed unchanged, so constants can be mixed in freely.

## How it works

1. At `onAdd`, each template is registered with
   `viewer.getFeatureinfo().featureinfotemplates.addFeatureinfotemplate()`.
2. When Origo builds the content into an infowindow, the template function is called.
   It returns HTML and at the same time queues a _rendering job_.
3. The queue is emptied when Origo emits `changeselection` or `itemadded` - both are emitted
   after the content has been inserted into the DOM - and at the next animation frame, for
   rendering paths that do not emit any events.
4. Each container is rendered exactly once; it is marked with
   `data-fi-template-rendered`. Jobs whose containers never appear (Origo can
   build attribute content that is then not displayed) are discarded after `pendingTimeout`.

Works for all infowindow modes: `overlay`, `sidebar` and `infowindow`.

## Troubleshooting

The plugin logs to the console when something goes wrong:

- `requires Origo 2.10.0 or later` - `featureinfotemplates` is missing on
  the featureinfo object. Check the Origo version.

- `cannot find function "..."` - `onVisible` points to a global function that
  does not exist. Make sure the script that defines it is loaded before the click
  (it is looked up first on call, not on registration).
- `template without "name" is skipped` - an entry in `templates` is missing `name`.

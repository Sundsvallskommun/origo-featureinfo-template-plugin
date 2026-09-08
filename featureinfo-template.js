/**
* Featureinfotemplate - Origo plugin for configurable infowindow templates.
*
* Registers one or more named featureinfo templates in a standard Origo
* (>= 2.10.0) via the public API
* `viewer.getFeatureinfo().featureinfotemplates.addFeatureinfotemplate()`.
*
* A template consists of two parts:
* 1. HTML that is written into the infowindow (overlay, sidebar or infowindow).
* 2. An optional callback that is only executed when the HTML is in the DOM, so that
* external code can draw diagrams, 3D views or other things in the container.
*
* Point 2 is solved with Origo's own featureinfo events (`changeselection`,
* `itemadded`).
*
* Requires Origo 2.10.0 or later. No other dependencies.
 *
 * @example <caption>index.html</caption>
 * <script src="plugins/featureinfo-template.js"></script>
 * <script>
 *   var origo = Origo('index.json');
 *   origo.on('load', function (viewer) {
 *     viewer.addComponent(Featureinfotemplate({
 *       templates: [{
 *         name: 'solay',
 *         html: '<div id="{{containerId}}"></div>',
 *         containerId: 'solkartan-popup',
 *         onVisible: 'solkartan.render_popup',
 *         onVisibleArgs: ['{{attributes}}', '{{containerId}}', 'data/3d']
 *       }]
 *     }));
 *   });
 * </script>
 *
 * @example <caption>index.json - koppla mallen till ett lager</caption>
 * { "name": "min:lagerNamn", "queryable": true, "attributes": "solay" }
 */
(function featureinfotemplatePlugin(global) {
  'use strict';

  /** Attribute that marks a container as already rendered. */
  var RENDERED_ATTR = 'data-fi-template-rendered';

  /** Counter for unique container IDs. */
  var counter = 0;

  /**
   * Resolves a function from a dot-separated path, e.g.
   * 'solkartan.render_popup', starting from a root object (default `window`).
   * This is done at call time so that the template can be registered before
   * the library that owns the function has loaded.
   *
   * @param {string|Function} ref Function or path to function.
   * @param {Object} [root] Root object to resolve in.
   * @returns {Function|null} The function, or null if it does not exist.
   */
  function resolveFunction(ref, root) {
    if (typeof ref === 'function') return ref;
    if (typeof ref !== 'string' || ref === '') return null;
    var parts = ref.split('.');
    var current = root || global;
    for (var i = 0; i < parts.length; i += 1) {
      if (current === null || current === undefined) return null;
      current = current[parts[i]];
    }
    return typeof current === 'function' ? current : null;
  }

  /**
  * HTML escapes a value so that attribute data from e.g. GetFeatureInfo
  * cannot inject markup into the template.   *
  * @param {*} value The value to escape.
  * @returns {string} The escaped string.
  */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Replaces {{placeholders}} in an HTML string. `{{containerId}}` gives
   * the container's id, all other names are looked up among the feature's attributes and
   * HTML-escaped. Unknown names are replaced with an empty string.
   *
   * @param {string} html Template HTML.
   * @param {string} containerId Container's id.
   * @param {Object} attributes The feature's attributes.
   * @returns {string} Finished HTML.
   */
  function interpolate(html, containerId, attributes) {
    return html.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, function replace(match, key) {
      if (key === 'containerId') return containerId;
      return escapeHtml(attributes ? attributes[key] : '');
    });
  }

  /**
   * Builds the argument list for the onVisible callback. An argument that is
   * exactly '{{attributes}}', '{{container}}', '{{containerId}}' or
   * '{{layer}}' is replaced with the corresponding value; other arguments are
   * passed through unchanged.
   *
   * @param {Array} spec Configured argument list.
   * @param {Object} job The rendering job.
   * @param {Element} container The container element.
   * @returns {Array} Arguments to call the callback with.
   */
  function buildArgs(spec, job, container) {
    return spec.map(function mapArg(arg) {
      if (arg === '{{attributes}}') return job.attributes;
      if (arg === '{{container}}') return container;
      if (arg === '{{containerId}}') return job.containerId;
      if (arg === '{{layer}}') return job.layer;
      return arg;
    });
  }

  /**
   * Creates the plugin component.
   *
   * @param {Object} [options] Configuration.
   * @param {Object[]} options.templates Templates to register.
   * @param {string} options.templates[].name Template name. Matches the layer's
   *   `attributes` string or an attribute's `template` in index.json.
   * @param {string} [options.templates[].html] HTML template with
   *   {{placeholders}}. Omitted if `render` is used.
   * @param {Function} [options.templates[].render] Function
   *   `(attributes, layer, containerId)` that returns HTML. Takes precedence
   *   over `html`.
   * @param {string} [options.templates[].containerId] Base ID of the container.
   *   Default `<name>-container`.
   * @param {boolean} [options.templates[].unique=true] Add a sequential number to
   *   the container's ID so that multiple simultaneous features don't collide.
   * @param {string|Function} [options.templates[].onVisible] Callback that is called
   *   when the container is in the DOM. A string is interpreted as a path to a global
   *   function and looked up first when called.
   * @param {Array} [options.templates[].onVisibleArgs] Arguments to the callback.
   *   Default `['{{container}}', '{{attributes}}', '{{layer}}']`.
   * @param {number} [options.pendingTimeout=10000] How long (ms) a job
   *   waits for its container to appear in the DOM before it is discarded.
   * @returns {Object} Origo-component.
   */
  var Featureinfotemplate = function Featureinfotemplate(options) {
    var opts = options || {};
    var templates = opts.templates || [];
    var pendingTimeout = typeof opts.pendingTimeout === 'number' ? opts.pendingTimeout : 10000;

    /** Jobs waiting for their container to end up in the DOM. */
    var pending = [];
    var flushScheduled = false;

    /**
     * Run the onVisible callback for a job.
     *
     * @param {Object} job The rendering job.
     * @param {Element} container The container element.
     */
    function invoke(job, container) {
      var fn = resolveFunction(job.config.onVisible);
      if (!fn) {
        console.warn('Featureinfotemplate: no feature found "' + job.config.onVisible
          + '" för mallen "' + job.config.name + '".');
        return;
      }
      var spec = job.config.onVisibleArgs || ['{{container}}', '{{attributes}}', '{{layer}}'];
      try {
        fn.apply(null, buildArgs(spec, job, container));
      } catch (err) {
        console.error('Featureinfotemplate: error in onVisible for the template "'
          + job.config.name + '".', err);
      }
    }

    /**
     * Goes through pending jobs and renders those whose container has appeared in the DOM.
     * Jobs that have been waiting longer than `pendingTimeout` are discarded.
     */
    function flush() {
      flushScheduled = false;
      var now = Date.now();
      for (var i = pending.length - 1; i >= 0; i -= 1) {
        var job = pending[i];
        var container = document.getElementById(job.containerId);
        if (container) {
          pending.splice(i, 1);
          if (!container.hasAttribute(RENDERED_ATTR)) {
            container.setAttribute(RENDERED_ATTR, '');
            invoke(job, container);
          }
        } else if (now - job.created > pendingTimeout) {
          pending.splice(i, 1);
        }
      }
    }

    /** Schedules a flush to the next animation frame. */
    function scheduleFlush() {
      if (flushScheduled) return;
      flushScheduled = true;
      global.requestAnimationFrame(flush);
    }

    /**
     * Builds the template function that is registered in Origo. Origo calls it with
     * the feature's attributes and layer, and writes the returned HTML into
     * the info window.
     *
     * @param {Object} config The template configuration.
     * @returns {Function} The template function `(attributes, layer) => string`.
     */
    function createTemplateFunction(config) {
      var baseId = config.containerId || (config.name + '-container');
      var unique = config.unique !== false;

      return function template(attributes, layer) {
        counter += 1;
        var containerId = unique ? baseId + '-' + counter : baseId;
        var html;
        if (typeof config.render === 'function') {
          html = config.render(attributes, layer, containerId);
        } else if (typeof config.html === 'string') {
          html = interpolate(config.html, containerId, attributes);
        } else {
          html = '<div id="' + containerId + '"></div>';
        }

        if (config.onVisible) {
          pending.push({
            config: config,
            containerId: containerId,
            attributes: attributes,
            layer: layer,
            created: Date.now()
          });
          // Covers rendering paths that do not trigger a featureinfo event.
          scheduleFlush();
        }
        return html;
      };
    }

    return global.Origo.ui.Component({
      name: 'featureinfotemplate',

      onAdd: function onAdd(evt) {
        var viewer = evt.target;
        var featureinfo = viewer.getFeatureinfo();
        if (!featureinfo || !featureinfo.featureinfotemplates) {
          console.error('Featureinfotemplate: requires Origo 2.10.0 or later.');
          return;
        }

        templates.forEach(function register(config) {
          if (!config || !config.name) {
            console.warn('Featureinfotemplate: template without "name" will be skipped.', config);
            return;
          }
          featureinfo.featureinfotemplates
            .addFeatureinfotemplate(config.name, createTemplateFunction(config));
        });

        // Origo emits these after the content has been inserted into the DOM - both when
        // an infowindow is opened and when the user browses between features.
        featureinfo.on('changeselection', scheduleFlush);
        featureinfo.on('itemadded', scheduleFlush);
      }
    });
  };

  global.Featureinfotemplate = Featureinfotemplate;
  if (typeof module === 'object' && module.exports) {
    module.exports = Featureinfotemplate;
  }
}(window));

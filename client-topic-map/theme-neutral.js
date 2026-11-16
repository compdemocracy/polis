/*
 * The neutral theme of the topic map and the topic list: every colour, type
 * size, stroke and spacing either of them uses, in this one object. A theme is
 * a plain object of this shape; nothing visual is written anywhere else.
 *
 * Where a value says "datamapplot", it is what datamapplot 0.6.4 draws for the
 * maps Delphi makes today (file and line in its source), so that the neutral
 * theme can be compared with it side by side. Values marked "new" have no
 * counterpart there, because datamapplot has no such thing as we use it.
 */
(function (root) {
  "use strict";

  var theme = {
    name: "neutral",

    /* Grounds and inks shared by the map and the list. */
    ground: "#ffffff",            // datamapplot: page_background_color, interactive_rendering.py:1982
    ink: "#000000",               // datamapplot: title_font_color, interactive_rendering.py:1948
    inkMuted: "#777777",          // datamapplot: sub_title_font_color, interactive_rendering.py:1949
    rule: "#dddddd",              // datamapplot: input_border, interactive_rendering.py:1953

    font: {
      family: "Roboto, sans-serif", // datamapplot: font_family, interactive_rendering.py:1129
      uiWeight: 400,
      uiSizePx: 14,                 // new: the list and the level control
      smallSizePx: 12               // new: counts and captions
    },

    /* The comments. */
    point: {
      fill: "topic",                    // "topic" = each topic's own colour from the data; or one CSS colour
      unclustered: "#aaaaaa",           // Delphi: noise_color, 700_datamapplot_for_layer.py:697
      opacity: 180 / 255,               // datamapplot: create_plots.py:692
      radiusMinPx: 2,                   // Delphi: point_radius_min_pixels, 700_datamapplot_for_layer.py:741
      radiusMaxPx: 10,                  // Delphi: point_radius_max_pixels, 700_datamapplot_for_layer.py:742
      stroke: "rgba(250,250,250,0.502)",// datamapplot: point_outline_color, interactive_rendering.py:1588
      strokeWidth: 0.001,               // datamapplot: point_line_width, in map units; pixels = this * 2^zoom
      strokeMinPx: 0.001,               // datamapplot: interactive_rendering.py:1145
      strokeMaxPx: 3,                   // datamapplot: interactive_rendering.py:1146
      hover: "rgba(170,0,0,0.733)",     // datamapplot: point_hover_color "#aa0000bb", interactive_rendering.py:1142
      /* Selection. datamapplot has one, for its search box and lasso, which the maps Delphi makes never
         turn on; these are its figures (datamap.js:159-161, 389-399). */
      dimOpacity: 0.4,                  // a comment outside the selected topic: datamapplot's half-selected point
      dimRadius: 0.4,
      selectedMinRadiusScale: 2         // a comment inside it is drawn at least 2 * (radiusMinPx + a little) wide
    },

    /* The topic names on the map. */
    label: {
      ink: "topic",                     // "topic" = each topic's darker label colour from the data; or one CSS colour
      weight: 500,                      // datamapplot asks for 600 (interactive_rendering.py:1130) but its page gets only
                                        // Roboto 400 and the browser thickens it; 500 of the real face is the nearest look
      sizeMinPx: 18,                    // datamapplot: min_fontsize, interactive_rendering.py:1137
      sizeMaxPx: 28,                    // datamapplot: max_fontsize, interactive_rendering.py:1138
      lineHeight: 0.95,                 // datamapplot: line_spacing, interactive_rendering.py:1136
      wrapChars: 16,                    // datamapplot: label_wrap_width, create_plots.py:350
      halo: "rgba(238,238,238,0.867)",  // datamapplot: text_outline_color "#eeeeeedd", interactive_rendering.py:1140
      haloEm: 0.122,                    // datamapplot: text_outline_width 8 saturates deck.gl's outline at 7.8 of 64 font units
      baselineEm: 0.3,                  // deck.gl: a line's baseline lies this far below the middle of its row
      plate: "rgba(255,255,255,0.251)", // datamapplot: text_background_color, interactive_rendering.py:1589
      platePadPx: 15,                   // datamapplot: getBackgroundPadding, datamap.js:219
      /* How much room a label claims when labels compete (datamap.js:230-237). */
      collisionScale: 3,                // datamapplot: text_collision_size_scale, interactive_rendering.py:1126
      collisionMinPx: 36,               // datamapplot: 2 * text_min_pixel_size
      collisionMaxPx: 72                // datamapplot: 2 * text_max_pixel_size
    },

    /* The comment shown under the pointer. */
    tooltip: {
      ink: "#000000",                   // datamapplot: _TOOL_TIP_CSS, interactive_rendering.py:165-175
      ground: "rgba(255,255,255,0.933)",
      weight: 300,
      sizePx: 12.8,                     // 0.8em of the page's 16px
      padPx: 10,                        // deck.gl's own tooltip padding
      radiusPx: 12,
      blurPx: 6,
      shadow: "2px 3px 10px rgba(170,170,170,0.267)",
      maxWidth: "25%"
    },

    /* The list of the same topics. All new: datamapplot has no list as we use it. */
    list: {
      rowPadPx: 4,
      indentPx: 16,
      swatchPx: 10,
      gapPx: 8,
      hoverGround: "#f2f2f2",
      selectedGround: "#e4e4e4",
      selectedWeight: 600
    },

    /* How long a zoom takes. */
    motion: {
      wheelMs: 250,                     // datamapplot: scrollZoom smooth, datamap.js:80 (deck.gl's 250 ms)
      doubleClickMs: 300                // deck.gl's double-click zoom
    }
  };

  root.POLIS_TOPIC_MAP_THEME_NEUTRAL = theme;
  if (typeof module !== "undefined" && module.exports) module.exports = theme;
})(typeof globalThis !== "undefined" ? globalThis : this);

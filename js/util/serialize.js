// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

//serializes a form present in the view, returning the serialized data
  //as an object
  //pass {set:false} to not update this.model if present
  //can pass options, callback or event in any order

function eachNamedInput(view, options, iterator) {
  var i = 0;

  $('select,input,textarea', options.root || view.el).each(function() {
    var $el = $(this);

    var type = $el.attr('type'),
        name = $el.attr('name');
    if (type !== 'button' && type !== 'cancel' && type !== 'submit' && name) {
      iterator($el, i, name, type);
      ++i;
    }
  });
}


//calls a callback with the correct object fragment and key from a compound name
function objectAndKeyFromAttributesAndName(attributes, name, options, callback) {
  var key,
      object = attributes,
      keys = name.split('['),
      mode = options.mode;

  for (var i = 0; i < keys.length - 1; ++i) {
    key = keys[i].replace(']', '');
    if (!object[key]) {
      if (mode === 'serialize') {
        object[key] = {};
      } else {
        return callback(undefined, key);
      }
    }
    object = object[key];
  }
  key = keys[keys.length - 1].replace(']', '');
  callback(object, key);
}


function serialize(view, callback, options) {
  options = options || {};
  var attributes = options.attributes || {};

  //callback has context of element
  eachNamedInput(view, options, function($element, i, name, type) {
    var value = getInputValue($element, type);
    if (!_.isUndefined(value)) {
      objectAndKeyFromAttributesAndName(attributes, name, {mode: 'serialize'}, function(object, key) {
        if (!object[key]) {
          object[key] = value;
        } else if (_.isArray(object[key])) {
          object[key].push(value);
        } else {
          object[key] = [object[key], value];
        }
      });
    }
  });

  if (callback) {
    callback.call(this, attributes);
  }
  return attributes;
}

function getInputValue($input, type) {
  if (type === 'checkbox' || type === 'radio') {
    // `prop` doesn't exist in fruit-loops, but it updates after user input.
    // whereas attr does not.
    var checked = $input[$input.prop ? 'prop' : 'attr']('checked');
    if (checked || checked === '') {
      // Under older versions of IE we see 'on' when no value is set so we want to cast this
      // to true.
      var value = $input.attr('value');
      return (value === 'on') || value || true;
    }
  } else {
    return $input.val() || '';
  }
}



module.exports = serialize;

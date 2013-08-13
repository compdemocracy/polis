!function (that) {
  'use strict';

  function include (array, item) {
    return array.indexOf(item) > -1;
  }

  function _traverseDown (context, iterator) {
    var doContinue = true;
  
    (function walkDown (node) {
      var i, newContext;
  
      if (!doContinue) return;
  
      if (iterator(node) === false) {
        //break the traversal loop if the iterator returns a falsy value
        doContinue = false;
      }
      else {
        for (i = 0; i < node.children.length; i++) {
          newContext = node.children[i];
          walkDown(newContext);
        }
      }
    })(context);
  }


  function _traverseUp (context, iterator) {
    var i, node, doContinue;

    while (context) {
      if ( iterator(context) === false ) return;

      for (i = 0; i < context.children.length; i++) {
        node = context.children[i];
        if ( iterator(node) === false ) return;
      }
      context = context.parent;
    }
  }
  
  
  function _traverse (context, iterator, callback) {
    var visited = [],
        callIterator = function (node) {
          var id = node.id,
              returned;
  
          if (! include(visited, id)) {
            returned = iterator.call(node, node);
            visited.push(id);
  
            if (returned === false) {
              return returned;
            }
          }
        },
        i, node;
  
    callback(context, callIterator);
  }
  

  function _removeChild (node) {
    var parent = node.parent, 
        child,
        i;
  
    for (i = 0; i < parent.children.length; i++) {
      child = parent.children[i];
  
      if (child === node) {
        return parent.children.splice(i, 1).shift();
      }
    }
  }
  
  function nodeId (parent, separator) {
    separator = separator || '/';
    if (parent) {
      return [parent.id, parent.children.length ].join(separator);
    }
    else {
      return '0';
    }
  }
  
  
  function Arboreal (parent, data, id) {
    this.depth = parent ? parent.depth + 1 : 0;
    this.data = data || {};
    this.parent = parent || null;
    this.id = id || nodeId(parent);
    this.children = [];
  }
  
  Arboreal.parse = function (object, childrenAttr) {
    var root, getNodeData = function (node) {
          var attr, nodeData = {};
          for (attr in node) {
            if (attr !== childrenAttr) nodeData[attr] = node[attr];
          }
          return nodeData;
        };
  
    (function walkDown(node, parent) {
      var newNode, i;
  
      if (!parent) {
        newNode = root = new Arboreal(null, getNodeData(node));
      } else {
        newNode = new Arboreal(parent, getNodeData(node));
        parent.children.push(newNode);
      }
      if (childrenAttr in node) {
        for (i = 0; i < node[childrenAttr].length; i++ ) {
          walkDown(node[childrenAttr][i], newNode);
        }
      }
    })(object);
  
    return root;
  
  };
  
  Arboreal.prototype.appendChild = function (data, id) {
    var child = new Arboreal(this, data, id);
    this.children.push(child);
    return this;
  };
  
  Arboreal.prototype.removeChild = function (arg) {
    if (typeof arg === 'number' && this.children[arg]) {
      return this.children.splice(arg, 1).shift();
    }
    if (arg instanceof Arboreal) {
      return _removeChild(arg);
    }
    throw new Error("Invalid argument "+ arg);
  };
  
  Arboreal.prototype.remove = function () {
    return _removeChild(this);
  };
  
  
  Arboreal.prototype.root = function () {
    var node = this;
  
    if (!node.parent) {
      return this;
    }
  
    while (node.parent) {
      node = node.parent;
    }
    return node;
  };
  
  Arboreal.prototype.isRoot = function () {
    return !this.parent;
  };
  
  Arboreal.prototype.traverseUp = function (iterator) {
    _traverse(this, iterator, _traverseUp);
  };
  
  Arboreal.prototype.traverseDown = function (iterator) {
    _traverse(this, iterator, _traverseDown);
  };
  
  Arboreal.prototype.toString = function () {
    var lines = [];
  
    this.traverseDown(function (node) {
      var separator = '|- ', indentation = '',  i;
  
      if (node.depth === 0) {
        lines.push(node.id);
        return;
      }
      for (i = 0; i < node.depth; i++) {
        indentation += ' ';
      }
      lines.push( indentation + separator + node.id);
    });
    return lines.join("\n");
  };
  
  Arboreal.prototype.find = function (finder) {
    var match = null,
        iterator = (typeof finder === 'function') ?
          finder : function (node) {
            if (node.id === finder) {
              match = node;
              return false;
            }
          };
  
    this.traverseDown(function (node) {
      if (iterator.call(this, node)) {
        match = node;
        return false;
      }
    });
  
    return match;
  };
  
  Arboreal.prototype.path = function (path, separator) {
    separator = separator || '/';
    //allow path to begin with 
    if (path[0] === separator) path = path.substring(1);
  
    var indexes = path.split(separator),
        index = null,
        context = this,
        i;
  
    for (i = 0; i < indexes.length; i++) {
      index = parseInt(indexes[i], 10);
      context = (context.children.length && context.children.length > index) ? 
        context.children[index] : null;
    }
  
    return context;
  };
  
  Arboreal.prototype.toArray = function () {
    var nodeList = [];
    this.traverseDown(function (node) {
      nodeList.push(node);
    });
    return nodeList;
  };

  Arboreal.prototype.__defineGetter__("length", function () {
    return this.toArray().length;
  });


  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Arboreal;
  } else {
    that.Arboreal = Arboreal;
  }

}(this);

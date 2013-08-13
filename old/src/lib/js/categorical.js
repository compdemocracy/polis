(function() {

function create(new_items, scoreFunction) {
    // Provide a uniform distribution by default.
    scoreFunction = scoreFunction ? scoreFunction : function() {return 1;};
    return _create(new_items, scoreFunction);
}

function _create(
    new_items,
    scoreFunction, 
    new_scores, // optional
    new_total_score // optional
) {
    var items = [],
        scores = [],
        totalScore = 0;

    function sum(ary) {
        var total = 0;
        for (var i = 0; i < ary.length; i++) {
            total += ary[i];
        }
        return total;
    }

    function addItems(more_items) {
        var more_scores = more_items.map(scoreFunction);
        scores.push.apply(scores, more_scores);
        totalScore += sum(more_scores);
        items.push.apply(items, more_items);
    }

    function takeAndFillVoid(index) {
        totalScore -= scores[index];
        scores[index] = scores[scores.length - 1];
        items[index] = items[items.length - 1];
        items.length -= 1;
        scores.length -= 1;
    }

    function choose(shouldTake) {
        if (items.length === 0) {
            console.error('asdfasdf');
            return null;
        }
        var score = Math.random() * totalScore;
        var accumulatedScore = 0;
        var i = 0;
        while (i < items.length) {
            accumulatedScore += scores[i];
            if (score < accumulatedScore) {
                break;
            }
        }
        if (i === items.length) {
            i -= 1;
            // TODO CHECK IF THERE WAS SOME SLACK HERE.. FLOATING POINT ERROR, ETC
            console.error('floating point error or something, choosing last item');
        }
        var item = items[i];
        if (shouldTake) {
            // remove the item.
            takeAndFillVoid(i);
        }
        return item;
    }

    function peek() {
        return choose(false);
    }
    function take() {
        return choose(true);
    }

    function clone() {
        return _create(items.slice(), scoreFunction, scores.slice(), totalScore);
    }

    if (undefined === new_scores || undefined === new_total_score) {
        addItems(new_items);
    } else {
        // optimized constructor for clone
        items = new_items;
        totalScore = new_total_score;
        scores = new_scores;
    }

    return Object.create({
        clone: clone,
        addItems:  addItems,
        peek: peek,
        take: take
    }, {
        length: { // possible to do away with Object.create by storing length, or do away with length in unit test
            get: function() {
                return items.length;
            }
        }
    });
}
  if (typeof module === 'undefined') {
    // we are in a browser
    window.categorical = {
        create : create
    };
  }
  else {
    module.exports = {
        create: create
    };
  }
}());




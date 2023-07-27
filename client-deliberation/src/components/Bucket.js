export function Bucket() {
  if (_.isNumber(arguments[0])) {
    alert("error 324");
    // var bid = arguments[0];
    // var people = arguments[1];
    // this.ppl = _.isArray(people) ? people : [];
    // this.bid = bid;
    // this.proj = {
    //     x: 0,
    //     y: 0
    // };
  } else {
    var o = arguments[0];
    this.bid = o.id || o.bid;
    this.gid = o.gid;
    this.count = o.count;
    this.hasTwitter = o.hasTwitter;
    this.hasFacebook = o.hasFacebook;
    this.twitter = o.twitter;
    this.facebook = o.facebook;
    if (o.clusterCount) { // TODO stop with this pattern
      this.clusterCount = o.clusterCount; // TODO stop with this pattern
    }
    if (!_.isUndefined(o.ptptoiCount)) { // TODO stop with this pattern
      this.ptptoiCount = o.ptptoiCount; // TODO stop with this pattern
    }
    if (o.containsSelf) { // TODO stop with this pattern
      this.containsSelf = true; // TODO stop with this pattern
    }
    if (o.ptptoi) { // TODO stop with this pattern
      this.ptptoi = true; // TODO stop with this pattern
    }
    this.priority = o.priority || 0;

    if (o.isSummaryBucket) { // TODO stop with this pattern
      this.isSummaryBucket = true; // TODO stop with this pattern
      if (_.isUndefined(o.gid)) {
        alert("bug ID 'cricket'");
      }
    }
    this.proj = o.proj;


    if (!_.isUndefined(o.gid)) { // TODO stop with this pattern
      this.gid = parseInt(o.gid); // TODO stop with this pattern
    }

    this.pic = o.pic;
    this.picture_size = o.picture_size;
  }

}
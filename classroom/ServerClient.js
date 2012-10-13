
var ServerClient = function(params) {

    var dummyComments = [
        {userID: 12, id: 2345, text: "G98adysfshdfl ahsdlifuhs aofh 8asdgfgsad fogasdog f89asdgf asd9g 7fg897 asdfg8asd 78fg7 89asdg7f g78 9adsf78 dsag8 8g7.",},
        {userID: 23, id: 3456, text: "Mizudshf iuashdf u ahsdf iudiosfhuads ofausdofas dfa.",},
        {userID: 34, id: 4567, text: "NDIFU hdsiufas df87 a sd87f8 7asd8yf  y87sadfy78 ay8s7d fy7 0asdy f807yawe9rtewi7sa6dftis7dtcfdsft 7ads6tf7 sdatf9s6 d.",},
        {userID: 45, id: 5678, text: "Wuahsdf8o asdyf87 asdyf798 asdyf9sadyf as9d78 fy asd780y f78 as9dy7 f789 sad7y f y.",},
        {userID: 56, id: 6789, text: "ASDfjoasdi fjoasdi fjpsad fjasfjdf  a9s8dfy89a0sdhASDfjoasdi fjoasdi fjpsad fjasfjdf.",},
    ];
    var commentIndex = 0;

    // function getNextStimulus() {}
    
    function isValidCommentID(commentID) {
        return isNumber(commentID);
    }

    function getNextComment() {
        var dfd = $.Deferred();
        if (commentIndex >= dummyComments.length) {
            dfd.reject();
        } else {
            dfd.resolve(dummyComments[commentIndex]);
            commentIndex += 1;
        }
        return dfd.promise();
    }

    function push(commentID) {
        var dfd = $.Deferred();
        if (isValidCommentID(commentID)) {
            dfd.reject();
        }
        console.log("ServerClient PUSH: " + commentID);
        setTimeout(dfd.resolve, 1000);
        return dfd.promise();
    }

    function pull(commentID) {
        var dfd = $.Deferred();
        if (isValidCommentID(commentID)) {
            dfd.reject();
        }
        console.log("ServerClient PULL: " + commentID);
        setTimeout(dfd.resolve, 1000);
        return dfd.promise();
    }

    function reportAsShown(commentID) {
        var dfd = $.Deferred();
        console.log("ServerClient SHOWN: " + commentID);
        setTimeout(dfd.resolve, 1000);
        return dfd.promise();
    }

    return {
        getNextComment: getNextComment,
        push: push,
        pull: pull,
        reportAsShown: reportAsShown,
    }
};

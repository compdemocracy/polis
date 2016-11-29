// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.



var i = 0;
function disappearingAlert(txt, visibleDuration) {
	var dfd = $.Deferred();
	var id = "polisAlert" + (i++);
	var $alert = $(
		"<span id='"+id+"' style='position: fixed; top: 50%; width:100%; text-align: center;'>"+
			"<span class='alert-info' style='opacity: 0.8; padding: 50px; box-shadow: 2px 5px 7px 1px #black;'>"+txt+"</span>" +
		"</span>"
	);
	$(document.body).append($alert);
	setTimeout(function() {
		$("#"+id).fadeOut(600, function() {
			$("#"+id).remove();
			dfd.resolve();
		});
	}, visibleDuration);
	return dfd.promise();
}

// polisAlert

//         <span id="starredLabel" class="alert-info" style="display: none; position: absolute; right: 56px; padding:20px;">Marked as important.</span>


module.exports = {
	disappearingAlert: disappearingAlert
};

// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "Συμφωνώ";
s.disagree = "Διαφωνώ";
s.pass = "Δεν είμαι σίγουρος";

s.importantCheckbox = "Αυτό το σχόλιο είναι σημαντικό";
s.howImportantPrompt = "Πόσο σημαντική είναι αυτή η ιδέα;";
s.howImportantLow = "Λίγο";
s.howImportantMedium = "Ούτε λίγο, ούτε πολύ";
s.howImportantHigh = "Πολύ";

s.modSpam = "Ανεπιθύμητο";
s.modOffTopic = "Εκτός θέματος";
s.modImportant = "Σημαντικό";
s.modSubmitInitialState = "Επόμενη ιδέα (καμία από τις παραπάνω)";
s.modSubmit = "Ολοκληρώθηκε, επόμενη ιδέα";

s.x_wrote = "έγραψε:";
s.x_tweeted = "tweeted:";
s.comments_remaining = "{{num_comments}} απομένουν";
s.comments_remaining2 = "{{num_comments}} εναπομείνασες ιδέες";
s.group_123 = "Ομάδα:";
s.comment_123 = "ιδέα:";
s.majorityOpinion = "Γνώμη πλειοψηφίας";
s.majorityOpinionShort = "Πλειοψηφία";
s.info = "Πληροφορία";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "Απόρρητο";
s.TOS = "TOS";
s.writePrompt = "Μοιραστείτε τη γνώμη σας...";
s.anonPerson = "Ανώνυμος";
s.helpWhatAmISeeingTitle = "Τί βλέπω;";
s.helpWhatAmISeeing = "Τα άτομα που ψηφίζουν παρόμοια ομαδοποιούνται. Κάντε κλικ σε μια ομάδα για να δείτε ποιες ιδέες μοιράζονται.";
s.helpWhatDoIDoTitle = " Τί να κάνω;";
s.helpWhatDoIDo = "Ψηφίστε τις ιδέες άλλων ατόμων πατώντας 'συμφωνώ' ή 'διαφωνώ'. Γράψτε μία ιδέα (καλύτερα για ένα θέμα μόνο). Προσκαλέστε τους φίλους σας στη συνομιλία!";
s.writeCommentHelpText = "Λείπει η οπτική ή η εμπειρία σας από τη συζήτηση; Αν ναι, <b>προσθέστε</b> στο κουτί από κάτω.";
s.helpWriteListIntro = "Τι κάνει μια ιδέα καλή;";
s.helpWriteListStandalone = "Ξεχωριστή ιδέα";
s.helpWriteListRaisNew = "Δώστε νέες προοπτικές, εμπειρίες ή προβληματισμούς";
s.helpWriteListShort = "Καθαρή και περιεκτική (να περιορίζεται σε 140 χαρακτήρες)";
s.heresHowGroupVoted = "Δείτε πως η Ομάδα {{GROUP_NUMBER}} ψήφισε:";
s.one_person = "{{x}} άτομο";
s.x_people = "{{x}} άτομα";
s.acrossAllPtpts = "Σε όλους τους συμμετέχοντες:";
s.xPtptsSawThisComment = " είδαν αυτή την ιδέα";
s.xOfThoseAgreed = "από τους συμμετέχοντες συμφώνησαν";
s.xOfthoseDisagreed = "από τους συμμετέχοντες διαφώνησαν";
s.opinionGroups = "Opinion Groups";
s.topComments = "Κορυφαίες Δηλώσεις";
s.divisiveComments = "Διχαστικές Δηλώσεις";
s.pctAgreed = "{{pct}}% Συμφώνησε";
s.pctDisagreed = "{{pct}}% Διαφώνησε";
s.pctAgreedLong = "{{pct}}% όσων ψήφισαν την ιδέα {{comment_id}} συμφώνησε.";
s.pctAgreedOfGroup = "{{pct}}% της Ομάδας {{group}} συμφώνησε";
s.pctDisagreedOfGroup = "{{pct}}% της Ομάδας {{group}} διαφώνησε";
s.pctDisagreedLong = "{{pct}}% όσων ψήφισαν την ιδέα {{comment_id}} διαφώνησαν.";
s.pctAgreedOfGroupLong = "{{pct}}% της Ομάδας {{group}} που ψήφισε την ιδέα {{comment_id}} συμφώνησε.";
s.pctDisagreedOfGroupLong = "{{pct}}% της Ομάδας {{group}} που ψήφισε την ιδέα {{comment_id}} διαφώνησε.";
s.commentSent = "Η ιδέα υποβλήθηκε! Μόνο άλλοι συμμετέχοντες θα δουν την ιδέα σας και θα συμφωνήσουν ή θα διαφωνήσουν.";
s.commentSendFailed = "Παρουσιάστηκε σφάλμα κατά την υποβολή της ιδέας σας.";
s.commentSendFailedEmpty = "Παρουσιάστηκε σφάλμα κατά την υποβολή της ιδέας σας - Η ιδέα δεν πρέπει να είναι κενή.";
s.commentSendFailedTooLong = "Παρουσιάστηκε σφάλμα κατά την υποβολή της ιδέας σας - Η ιδέα είναι πολύ μεγάλη.";
s.commentSendFailedDuplicate = "Παρουσιάστηκε σφάλμα κατά την υποβολή της ιδέας σας - Μια παρόμοια ιδέα υπάρχει ήδη.";
s.commentErrorDuplicate = "Η ιδέα υπάρχει ήδη.";
s.commentErrorConversationClosed = "Αυτή η συνομιλία έχει κλείσει. Δεν μπορούν να υποβληθούν περαιτέρω δηλώσεις.";
s.commentIsEmpty = "Η ιδέα είναι κενή";
s.commentIsTooLong = "Η ιδέα είναι πολύ μεγάλη";
s.hereIsNextStatement = "Η ψήφος ήταν επιτυχής. Πλοηγηθείτε προς τα επάνω για να δείτε την επόμενη ιδέα.";

s.connectFacebook = "Σύνδεση με Facebook";
s.connectTwitter = "Σύνδεση με Twitter";
s.connectToPostPrompt = "Συνδεθείτε μ' έναν λογαριασμό για να υποβάλετε μια ιδέα. Δε θα δημοσιευτεί στο χρονολόγιο σας.";
s.connectToVotePrompt = "Συνδεθείτε μ' έναν λογαριασμό για να ψηφίσετε. Δε θα δημοσιευτεί στο χρονολόγιο σας.";
s.tip = "Συμβουλή:";
s.commentWritingTipsHintsHeader = "Συμβουλές για τη δημιουργία ιδεών";
s.tipCharLimit = "Οι ιδέες περιορίζονται σε {{char_limit}} χαρακτήρες.";
s.tipCommentsRandom = "Παρακαλώ να θυμάστε, Οι ιδέες εμφανίζονται τυχαία και δεν απαντάτε απευθείας στις ιδέες άλλων συμμετεχόντων.";
s.tipOneIdea = "Χωρίστε τις μεγάλες ιδέες που περιέχουν πολλά θέματα. Αυτό διευκολύνει τους άλλους να ψηφίσουν την ιδέα σας.";
s.tipNoQuestions = "Οι ιδέες δεν πρέπει να έχουν την μορφή ερώτησης. Οι συμμετέχοντες θα συμφωνήσουν ή θα διαφωνήσουν με τις ιδέες που θα υποβάλετε.";
s.commentTooLongByChars = "Η ιδέα ξεπερνά το όριο κατά {{CHARACTERS_COUNT}} χαρακτήρες.";
s.notSentSinceDemo = "(αυτό ειναι πρόχειρο)";
s.submitComment = "Υποβολή";
s.tipStarred = "Επισήμανση ως σημαντικό.";
s.participantHelpWelcomeText = "Καλώς ορίσατε σε ένα νέο είδος συνομιλίας - <em>ψηφίστε</em> ιδέες άλλων.";
s.participantHelpGroupsText = "Άτομα που ψηφίζουν παρόμοια <span style='font-weight: 700;'>ομαδοποιούνται.</span> Πατήστε σε μία ομάδα για να δείτε ποιες απόψεις μοιράζονται. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...περισσότερα</a>";
s.participantHelpGroupsNotYetText = "Η απεικόνιση θα εμφανιστεί αφού έχουν ψηφίσει 7 συμμετέχοντες";
s.helpWhatAreGroupsDetail = "<p>Έχετε πιθανώς δει 'προτεινόμενα προϊόντα' στην Amazon, ή 'προτεινόμενες ταινίες' στο Netflix. Κάθε μία από αυτές τις υπηρεσίες χρησιμοποιεί στατιστικά στοιχεία για να ομαδοποιήσει τον χρήστη με άλλους που αγοράζουν και βλέπουν παρόμαια προϊόντα και μετά τους δείχνει προϊόντα που αυτά τα άτομα αγόρασαν ή είδαν.</p> <p> Όταν ένας χρήστης ψηφίζει μία ιδέα, ομαδοποιείται με άτομα που ψήφισαν όπως αυτός! Μπορείτε να δείτε τις ομάδες παρακάτω. Η κάθε μία αποτελείται από άτομα που ψήφισαν παρόμοιες ιδέες. Υπάρχουν συναρπαστικές ιδέες και πληροφορίες για να ανακαλύψετε σε κάθε συνομιλία. Κάντε κλικ σε μία ομάδα για να δείτε τι ένωσε τους συμμετέχοντες και τι τους κάνει ξεχωριστούς! </p>";
s.socialConnectPrompt = "Συνδεθείτε προαιρετικά για να δείτε φίλους και άτομα που ακολουθείτε στην οπτικοποίηση.";
s.connectFbButton = "Σύνδεση με Facebook";
s.connectTwButton = "Σύνδεση με Twitter";
s.polis_err_reg_fb_verification_email_sent = "Παρακαλώ, ελέγξτε το email σας για τον σύνδεσμο επαλήθευσης και μετά επιστρέψτε εδώ για να συνεχίσετε.";
s.polis_err_reg_fb_verification_noemail_unverified = "Ο λογαριασμός σας στο Facebook δεν έχει επαληθευτεί. Παρακαλώ, επαληθεύστε το email σας με το Facebook και μετά επιστρέψτε εδώ για να συνεχίσετε.";
s.showTranslationButton = "Ενεργοποίηση μετάφρασης";
s.hideTranslationButton = "Απενεργοποίηση μετάφρασης ";
s.thirdPartyTranslationDisclaimer = "Η μετάφραση παρέχεται από τρίτο μέρος";

s.notificationsAlreadySubscribed = "Έχετε εγγραφεί στις ειδοποιήσεις για αυτήν τη συνομιλία.";
s.notificationsGetNotified = "Λάβετε ειδοποίηση όταν νέες ιδέες δημιουργούνται:";
s.notificationsEnterEmail = "Εισάγετε τη διεύθυνση email σας για να λαμβάνετε ειδοποίηση όταν φτάνουν νέες ιδέες:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Εγγραφή";
s.notificationsSubscribeErrorAlert = "Σφάλμα εγγραφής";
s.noCommentsYet = "Δεν υπάρχουν ακόμη ιδέες.";
s.noCommentsYetSoWrite = "Ξεκινήστε αυτήν τη συζήτηση προσθέτοντας μια ιδέα.";
s.noCommentsYetSoInvite = "Ξεκινήστε αυτήν τη συζήτηση προσκαλώντας περισσότερους συμμετέχοντες ή προσθέστε μια ιδέα.";
s.noCommentsYouVotedOnAll = "Έχετε ψηφίσει όλες τις ιδέες.";
s.noCommentsTryWritingOne = "Εάν έχετε κάτι να προσθέσετε, δοκιμάστε να γράψετε τη δική σας ιδέα.";
s.convIsClosed = "Αυτή η συζήτηση έχει κλείσει.";
s.noMoreVotingAllowed = "Δεν επιτρέπεται περαιτέρω ψηφοφορία.";


s.topic_good_01 = "Τι να κάνουμε με το δωμάτιο του πινγκ πονκ;";
s.topic_good_01_reason = "ανοικτό, ο καθένας μπορεί να έχει γνώμη για τις απαντήσεις σε αυτήν την ερώτηση.";
s.topic_good_02 = "Τι πιστεύετε για τη νέα πρόταση;";
s.topic_good_02_reason = "ανοικτό, ο καθένας μπορεί να έχει γνώμη για τις απαντήσεις σε αυτήν την ερώτηση.";
s.topic_good_03 = "Μπορείτε να σκεφτείτε κάτι που επιβραδύνει την παραγωγικότητα;";

s.topic_bad_01 = "Να αναφέρουν όλοι την ετοιμότητα του για την έναρξη.";
s.topic_bad_01_reason = "άτομα από διάφορες ομάδες θα ψηφίσουν για τις απαντήσεις, αλλά μπορεί να μην έχουν αρκετές γνώσεις για να ψηφίσουν με αυτοπεποίθηση.";
s.topic_bad_02 = "τι εμποδίζει την εκκίνηση;";
s.topic_bad_02_reason = "";


module.exports = s;
// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

s.agree = "En accord";
s.disagree = "En désaccord";
s.pass = "Neutre / Incertain";

s.modSpam = "Pourriel";
s.modOffTopic = "Hors sujet";
s.modImportant = "Important";
s.modSubmitInitialState = "Aucune de ces réponses – Passer à la prochaine affirmation";
s.modSubmit = "Terminé – Passer à la prochain affirmation";

s.x_wrote = "a écrit :";
s.x_tweeted = "a publié sur Twitter :";
s.comments_remaining = "Il en reste {{num_comments}}";
s.comments_remaining2 = "Il reste {{num_comments}} autres affirmations";
s.group_123 = "Groupe :";
s.comment_123 = "Affirmation :";
s.majorityOpinion = "Opinion de la majorité";
s.majorityOpinionShort = "Majorité";
s.info = "Info";
s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";
s.privacy = "Avis de confidentialité";
s.TOS = "Conditions du service";
s.writePrompt = "Faites connaître votre point de vue...";
s.anonPerson = "Anonyme";
s.helpWhatAmISeeingTitle = "Que suis-je en train de voir?";
s.helpWhatAmISeeing = "Toutes les personnes qui ont voté de façon semblable sont regroupées. Cliquez sur un groupe pour connaître le point de vue des membres.";
s.helpWhatDoIDoTitle = "Que dois-je faire?";
s.helpWhatDoIDo = "Votez sur les affirmations des autres participants. Pour ce faire, cliquez sur « En accord » ou « En désaccord », puis rédigez une affirmation (une idée = une affirmation). Invitez vos amis à participer à la conversation!";
s.writeCommentHelpText = "Si votre point de vue n’est pas déjà représenté, <em>publiez</em> une affirmation!</i>";
s.heresHowGroupVoted = "Voici comment le groupe {{GROUP_NUMBER}} a voté :";
s.one_person = "{{x}} personne";
s.x_people = "{{x}} personnes";
s.acrossAllPtpts = "Parmi tous les participants :";
s.xPtptsSawThisComment = " ont vu cette affirmation ";
s.xOfThoseAgreed = "d’entre eux sont en accord avec l’affirmation";
s.xOfthoseDisagreed = "d’entre eux sont en désaccord avec l’affirmation";
s.opinionGroups = "Groupes d’opinion";
s.pctAgreed = "{{pct}} % étaient en accord avec l’affirmation";
s.pctDisagreed = "{{pct}} % étaient en désaccord avec l’affirmation";
s.pctAgreedLong = "{{pct}} % des personnes qui ont voté au sujet de l’énoncé {{comment_id}} étaient en accord avec celui-ci.";
s.pctAgreedOfGroup = "{{pct}} % des membres du groupe {{group}} étaient en accord avec l'affirmation";
s.pctDisagreedOfGroup = "{{pct}} % des membres du groupe {{group}} étaient en désaccord avec l’affirmation";
s.pctDisagreedLong = "{{pct}} % des personnes qui ont voté au sujet de l’énoncé {{comment_id}} étaient en désaccord avec celui-ci.";
s.pctAgreedOfGroupLong = "{{pct}} % des membres du groupe {{group}} ayant voté au sujet de l’énoncé {{comment_id}} étaient en accord avec celui-ci.";
s.pctDisagreedOfGroupLong = "{{pct}} % des membres du groupe {{group}} ayant voté au sujet de l’affirmation {{comment_id}} étaient en désaccord avec celui-ci.";
s.commentSent = "Énoncé publié! Les autres participants verront votre publication et indiqueront s’ils sont en accord ou en désaccord avec l’affirmation.";
s.commentSendFailed = "Une erreur est survenue. Impossible de publier l’affirmation.";
s.commentErrorDuplicate = "Doublon! Cet énoncé a déjà été publié.";
s.commentErrorConversationClosed = "Cette conversation est fermée. Impossible de publier de nouvelles affirmations.";
s.commentIsEmpty = "L’affirmation est vide.";
s.commentIsTooLong = "L’affirmation est trop longue.";

s.connectFacebook = "Connexion à Facebook";
s.connectTwitter = "Connexion à Twitter";
s.connectToPostPrompt = "Connectez-vous pour publier une affirmation. Nous ne publierons pas votre journal.";
s.connectToVotePrompt = "Connectez-vous pour voter. Nous ne publierons pas votre journal.";
s.tip = "Conseil :";
s.commentWritingTipsHintsHeader = "Conseils pour rédiger une affirmation";
s.tipCharLimit = "Les énoncés doivent compter au plus {{char_limit}} caractères.";
s.tipCommentsRandom = "Les affirmations s’affichent de manière aléatoire. Ainsi, vous ne répondez directement à personne.";
s.tipOneIdea = "Subdivisez en plusieurs affirmations les affirmations trop longues qui traitent de plus d’une idée. Cela facilitera le vote.";
s.tipNoQuestions = "Une affirmation ne doit pas être présentée sous la forme d’une question. Les participants indiqueront s’ils sont en accord ou en désaccord avec votre affirmation.";
s.commentTooLongByChars = "L’affirmation compte {{CHARACTERS_COUNT}} caractères en trop.";
s.notSentSinceDemo = "(Ceci est une démonstration)";
s.submitComment = "Publier";
s.tipStarred = "Marqué comme étant important.";
s.participantHelpWelcomeText = "Bienvenue à un nouveau mode de conversation : <em>votez</em> sur les affirmations des autres participants ";
s.participantHelpGroupsText = "Toutes les personnes qui ont voté de façon semblable <span style='font-weight: 700;'>sont regroupées.</span> Cliquez sur un groupe pour connaître le point de vue des membres.<a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...(plus)</a>";
s.participantHelpGroupsNotYetText = "Le volet de visualisation s’affichera une fois qu’au moins 7 participants auront voté. ";
s.helpWhatAreGroupsDetail = "<p>Vous avez probablement déjà consulté la section sur les produits recommandés d’Amazon, ou celle des films recommandés sur Netflix. Chacun de ces services se fonde sur les statistiques pour regrouper l’utilisateur avec d’autres qui achètent des produits ou regardent des films similaires, puis présente les articles que ces autres utilisateurs ont acheté ou regardé. </p> <p> Lorsqu’un participant vote au sujet d’une affirmation, il est regroupé avec d’autres participants qui ont voté comme lui! Vous pouvez voir ci-dessous les groupes ainsi formés. Chacun est constitué de participants ayant des opinions semblables. Chaque conversation permet de faire des découvertes fascinantes. Allez-y! Cliquez sur un groupe pour voir ce que les membres ont en commun et ce qui les distingue des autres! </p>";
s.socialConnectPrompt = "Vous pouvez aussi vous connecter au forum pour voir vos amis et les personnes que vous suivez dans le volet de visualisation.";
s.connectFbButton = "Connectez-vous avec votre compte Facebook";
s.connectTwButton = "Connectez-vous avec votre compte Twitter";
s.polis_err_reg_fb_verification_email_sent = "Veuillez vérifier votre boîte de courriel et cliquez sur le lien de vérification. Revenez ensuite ici pour continuer.";
s.polis_err_reg_fb_verification_noemail_unverified = "Votre compte Facebook n’a pas été confirmé. Veuillez vérifier l’adresse de courriel que vous utilisez avec votre compte Facebook, puis revenez ici pour continuer.";
s.showTranslationButton = "Activer le service de traduction ";
s.hideTranslationButton = "Désactiver le service de traduction";

s.notificationsAlreadySubscribed = "Vous êtes abonné aux mises jour de cette conversation.";
s.notificationsGetNotified = "Recevez un avis lorsque de nouvelles affirmations sont publiées :";
s.notificationsEnterEmail = "Saisissez votre adresse de courriel pour recevoir un message lorsque de nouvelles affirmations sont publiées :";
s.labelEmail = "Adresse";
s.notificationsSubscribeButton = "M’abonner";
s.noCommentsYet = "Aucune affirmation n’a encore été publiée.";
s.noCommentsYetSoWrite = "Lancez la conversation en publiant une affirmation.";
s.noCommentsYetSoInvite = "Lancez la conversation en invitant d’autres participants ou en ajoutant une affirmation.";
s.noCommentsYouVotedOnAll = "Vous avez voté sur toutes les affirmations.";
s.noCommentsTryWritingOne = "Si vous souhaitez ajouter quelque chose, rédigez votre propre affirmation.";
s.convIsClosed = "Cette conversation est fermée.";
s.noMoreVotingAllowed = "Aucun autre vote n’est autorisé.";


module.exports = s;

// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var s = {};

// Text on the card 

s.participantHelpWelcomeText = "Zapraszamy do nowej formy rozmowy - <em>głosuj</em> na wypowiedzi innych osób.";

s.agree = "Zgadzam się";
s.disagree = "Nie zgadzam się";
s.pass = "Pomiń / Niepewny";

s.writePrompt = "Wyraź swoje zdanie, opinie i pomysły...";
s.anonPerson = "Anonimowy";
s.importantCheckbox = "Ważne/Znaczące";
s.importantCheckboxDesc =
  "Zaznacz to pole, jeśli uważasz, że ta wypowiedź jest dla Ciebie szczególnie ważna lub jest wysoce istotna dla rozmowy, niezależnie od Twojego głosu. Nada to tej wypowiedzi wyższy priorytet w porównaniu z innymi Twoimi głosami w analizie rozmowy.";
s.howImportantPrompt = "Jak ważna jest ta wypowiedź?";
s.howImportantLow = "Niska";
s.howImportantMedium = "Średnia";
s.howImportantHigh = "Wysoka";

s.modSpam = "Spam";
s.modOffTopic = "Poza tematem";
s.modImportant = "Ważne";
s.modSubmitInitialState = "Pomiń (żadne z powyższych), następna wypowiedź";
s.modSubmit = "Gotowe, następna wypowiedź";

s.x_wrote = "napisał(a):";
s.x_tweeted = "opublikował/opublikowała:";
s.comments_remaining = "Pozostało {{num_comments}}";
s.comments_remaining2 = "Pozostało {{num_comments}} wypowiedzi";

// Text about phasing

s.noCommentsYet = "Nie ma jeszcze żadnych wypowiedzi.";
s.noCommentsYetSoWrite = "Rozpocznij tę rozmowę, dodając wypowiedź.";
s.noCommentsYetSoInvite = "Rozpocznij tę rozmowę, zapraszając więcej uczestników/uczestniczek lub dodając wypowiedź.";
s.noCommentsYouVotedOnAll = "Oceniono wszystkie wypowiedzi.";
s.noCommentsTryWritingOne = "Jeśli chcesz coś dodać, zapisz swoją wypowiedź.";
s.convIsClosed = "Ta rozmowa jest zamknięta.";
s.noMoreVotingAllowed = "Dalsze głosowanie nie jest dozwolone.";

// For the visualization below

s.group_123 = "Grupa:";
s.comment_123 = "Wypowiedź:";
s.majorityOpinion = "Opinia większości";
s.majorityOpinionShort = "Większość";
s.info = "Informacje";
s.helpWhatAmISeeingTitle = "Co widzę?";
s.helpWhatAmISeeing = "Osoby, które głosują podobnie, są grupowane. Kliknij grupę, aby zobaczyć, jakie mają wspólne poglądy.";
s.heresHowGroupVoted = "Oto jak głosowała Grupa {{GROUP_NUMBER}}:";
s.one_person = "{{x}} osoba";
s.x_people = "{{x}} osób";
s.acrossAllPtpts = "Wśród wszystkich uczestników/uczestniczek:";
s.xPtptsSawThisComment = " zobaczyło tę wypowiedź";
s.xOfThoseAgreed = "z tych uczestników/uczestniczek zgodziło się";
s.xOfthoseDisagreed = "z tych uczestników/uczestniczek nie zgodziło się";
s.opinionGroups = "Grupy opinii";
s.topComments = "Najlepsze wypowiedzi";
s.divisiveComments = "Kontrowersyjne wypowiedzi";
s.pctAgreed = "{{pct}}% zgodziło się";
s.pctDisagreed = "{{pct}}% nie zgodziło się";
s.pctAgreedLong = "{{pct}}% wszystkich, którzy głosowali na wypowiedź {{comment_id}}, zgodziło się.";
s.pctAgreedOfGroup = "{{pct}}% Grupy {{group}} zgodziły się";
s.pctDisagreedOfGroup = "{{pct}}% Grupy {{group}} nie zgodziły się";
s.pctDisagreedLong = "{{pct}}% wszystkich, którzy głosowali na wypowiedź {{comment_id}}, nie zgodziło się.";
s.pctAgreedOfGroupLong = "{{pct}}% z grupy {{group}}, którzy głosowali na wypowiedź {{comment_id}}, zgodziło się.";
s.pctDisagreedOfGroupLong = "{{pct}}% z grupy {{group}}, którzy głosowali na wypowiedź {{comment_id}}, nie zgodziło się.";
s.participantHelpGroupsText = "Osoby, które głosują podobnie, <span style='font-weight: 700;'>są grupowane.</span> Kliknij grupę, aby zobaczyć, jakie mają wspólne poglądy. <a style='font-weight: 700; cursor: pointer; text-decoration: underline' id='helpTextGroupsExpand'>...więcej</a>";
s.participantHelpGroupsNotYetText = "Wizualizacja pojawi się, gdy 7 uczestników/uczestniczek rozpocznie głosowanie";
s.helpWhatAreGroupsDetail = "<p>Prawdopodobnie widziałeś/widziałaś 'polecane produkty' na Amazonie lub 'polecane filmy' na Netflixie. Każda z tych usług używa statystyk, aby pogrupować użytkownik/użytkowniczkę  z osobami, które kupują i oglądają podobne rzeczy, a następnie pokazują im rzeczy, które tamci ludzie kupili lub obejrzeli.</p> <p>Kiedy użytkownik/użytkowiczka głosuje na wypowiedzi, jest grupowany z ludźmi, którzy głosowali tak jak on/ona! Możesz zobaczyć te grupy poniżej. Każda składa się z osób o podobnych opiniach. W każdej rozmowie można odkryć interesujące spostrzeżenia. Śmiało - kliknij grupę, aby zobaczyć, co ich połączyło i co czyni ich wyjątkowymi! </p>";

// Text about writing your own statement

s.helpWhatDoIDoTitle = "Co mam robić?";
s.helpWhatDoIDo = "Głosuj na wypowiedzi innych osób, klikając 'zgadzam się' lub 'nie zgadzam się'. Napisz własną wypowiedź (skup się jednym wątku w wypowiedzi). Zaproś swoich znajomych do rozmowy!";
s.writeCommentHelpText = "Czy Twoje perspektywy lub doświadczenia są pominięte w tej rozmowie? Jeśli tak, <b>dodaj je</b> w polu poniżej.";
s.helpWriteListIntro = "Co sprawia, że wypowiedź jest dobra?";
s.helpWriteListStandalone = "Niezależna koncepcja ";
s.helpWriteListRaisNew = "Przedstawia nowe perspektywy, doświadczenia lub kwestie";
s.helpWriteListShort = "Jasna i zwięzła (ograniczona do 140 znaków)";
s.tip = "Wskazówka:";
s.commentWritingTipsHintsHeader = "Wskazówki dotyczące pisania wypowiedzi";
s.tipCharLimit = "Wypowiedzi są ograniczone do {{char_limit}} znaków.";
s.tipCommentsRandom = "Pamiętaj, wypowiedzi są wyświetlane losowo i nie odpowiadasz bezpośrednio na wypowiedzi innych uczestników.";
s.tipOneIdea = "Podziel długie wypowiedzi na mniejsze, zawierające jedną myśl. Ułatwi to innym głosowanie na Twoje zdanie ";
s.tipNoQuestions = "Wypowiedzi nie powinny mieć formy pytania. Uczestnicy/Uczestniczki będą zgadzać się lub nie zgadzać z Twoimi wypowiedziami.";
s.commentTooLongByChars = "Limit długości wypowiedzi przekroczony o {{CHARACTERS_COUNT}} znaków.";
s.submitComment = "Prześlij";
s.commentSent = "Wypowiedź została przesłana! Tylko inne osoby uczestniczące zobaczą Twoją wypowiedź i będą mogli się z nią zgodzić lub nie.";

// Error notices

s.commentSendFailed = "Wystąpił błąd podczas przesyłania Twojej wypowiedzi.";
s.commentSendFailedEmpty = "Wystąpił błąd podczas przesyłania Twojej wypowiedzi - Wypowiedź nie powinna być pusta.";
s.commentSendFailedTooLong = "Wystąpił błąd podczas przesyłania Twojej wypowiedzi - Wypowiedź jest zbyt długa.";
s.commentSendFailedDuplicate = "Wystąpił błąd podczas przesyłania Twojej wypowiedzi - Identyczna wypowiedź już istnieje.";
s.commentErrorDuplicate = "Duplikat! Taka wypowiedź już istnieje.";
s.commentErrorConversationClosed = "Ta rozmowa jest zamknięta. Nie można przesłać dalszych wypowiedzi.";
s.commentIsEmpty = "Wypowiedź jest pusta";
s.commentIsTooLong = "Wypowiedź jest zbyt długa";
s.hereIsNextStatement = "Oddano głos pomyślnie. Przewiń w górę, aby zobaczyć następną wypowiedź.";

// Text about connecting identity

s.connectFacebook = "Połącz z Facebookiem";
s.connectTwitter = "Połącz z X";
s.connectToPostPrompt = "Połącz konto, aby przesłać wypowiedź. Nie będziemy publikować na Twojej osi czasu.";
s.connectToVotePrompt = "Połącz konto, aby głosować. Nie będziemy publikować na Twojej osi czasu.";
s.socialConnectPrompt = "Opcjonalnie połącz konto, aby zobaczyć znajomych i osoby, które obserwujesz, w wizualizacji.";
s.connectFbButton = "Połącz z Facebookiem";
s.connectTwButton = "Połącz z X";
s.polis_err_reg_fb_verification_email_sent = "Sprawdź swoją skrzynkę e-mail, kliknij na link aby zweryfikować swoje konto, a następnie wróć tutaj, aby kontynuować. ";
s.polis_err_reg_fb_verification_noemail_unverified = "Twoje konto na Facebooku jest niezweryfikowane. Zweryfikuj swój adres e-mail na Facebooku, a następnie wróć tutaj, aby kontynuować.";

// Text for the third party translation that appears on the cards

s.showTranslationButton = "Aktywuj tłumaczenie zewnętrzne";
s.hideTranslationButton = "Dezaktywuj tłumaczenie";
s.thirdPartyTranslationDisclaimer = "Tłumaczenie dostarczone przez zewnętrznego dostawcę";

// Text about notifications and subscriptions and embedding

s.notificationsAlreadySubscribed = "Jesteś subskrybentem aktualizacji tej rozmowy.";
s.notificationsGetNotified = "Otrzymuj powiadomienia, gdy pojawią się nowe wypowiedzi:";
s.notificationsEnterEmail = "Wpisz swój adres e-mail, aby otrzymywać powiadomienia, gdy pojawią się nowe wypowiedzi:";
s.labelEmail = "Email";
s.notificationsSubscribeButton = "Subskrybuj";
s.notificationsSubscribeErrorAlert = "Błąd podczas subskrypcji";

s.addPolisToYourSite = "<img style='height: 20px; margin: 0px 4px;' src='{{URL}}'/>";

// Footer

s.privacy = "Prywatność";
s.TOS = "Regulamin";

// Experimental features

s.importantCheckbox = "Ta wypowiedź jest ważna";
s.howImportantPrompt = "Jak ważna jest ta wypowiedź?";
s.howImportantLow = "Niska";
s.howImportantMedium = "Średnia";
s.howImportantHigh = "Wysoka";
s.tipStarred = "Oznaczono jako ważne.";

s.modSpam = "Spam";
s.modOffTopic = "Poza tematem";
s.modImportant = "Ważne";
s.modSubmitInitialState = "Pomiń (żadne z powyższych), następna wypowiedź";
s.modSubmit = "Gotowe, następna wypowiedź";

s.topic_good_01 = "Co powinniśmy zrobić z pokojem do ping-ponga?";
s.topic_good_01_reason = "Pytanie otwarte, na które każda osoba może wyrazić opinię na temat udzielonych odpowiedzi.";
s.topic_good_02 = "Co sądzisz o nowej propozycji?";
s.topic_good_02_reason = "Pytanie otwarte, na które każda osoba może wyrazić opinię na temat udzielonych odpowiedzi.";
s.topic_good_03 = "Czy możesz wymienić coś, co spowalnia produktywność?";

s.topic_bad_01 = "wszyscy zgłoście swoją gotowość do uruchomienia";
s.topic_bad_01_reason = "Ludzie z różnych zespołów będą głosować na odpowiedzi, ale mogą nie mieć wystarczającej wiedzy, aby głosować z pewnością siebie.";
s.topic_bad_02 = "Jakie są nasze przeszkody w uruchomieniu?";
s.topic_bad_02_reason = "";

// Old unused error message from when Polis was a demo <3

s.notSentSinceDemo = "(nie naprawdę, to jest demo)";

module.exports = s;






### Polis is an open-source AI system that helps entire cities, states, or even countries find common ground on complex issues. By collecting and analyzing viewpoints from thousands of participants, Polis reveals breakthrough points of consensus—even on topics that seem deadlocked.  To date, over ten million people have used Polis in tens of thousands of conversations worldwide.

Polis has become part of the national democratic infrastructure in Taiwan, the UK, and Finland. Taiwan has used it to craft legislation on issues ranging from Uber regulation to revenge porn and online liquor sales; the UK has employed it for national security consultations; and Finland uses it to design social welfare and healthcare services within its wellbeing services counties. Governments in Singapore and the Philippines have also adopted the platform, while in Austria, the Klimarat (the National Citizens’ Assembly on Climate) used Polis to bring together thousands of citizens and experts to develop climate proposals.

At the local level, Amsterdam, Bowling Green, Kentucky, and multiple UK cities have used Polis to improve residents' lives. The United Nations Development Programme (UNDP) deployed it for what it called "the largest online deliberative exercises in history," engaging 30,000 youth across Bhutan, East Timor, and Pakistan.

Polis is designed, engineered, and maintained by The Computational Democracy Project (CompDem), a U.S.-based 501(c)(3). The tool has been featured in MIT Technology Review, Wired, The Economist, and The New York Times, and in BBC and PBS documentaries.

Polis case studies from around the world: [https://compdemocracy.org/Case-studies](https://compdemocracy.org/Case-studies)

## Polis 2.0

CompDem is now introducing Polis 2.0, an enhanced version of the original Polis 1.0 platform. This upgraded system combines massive participation capacity—supporting millions of simultaneous participants—with automated mapping of hundreds of thousands of individual viewpoints, real-time LLM-generated summaries, and the ability to keep conversations open indefinitely.

Polis 2.0 achieves this transformative scale through four key mechanisms:

* **Scalable Cloud Infrastructure:** A robust, cloud-powered distributed system scales in real time to meet demand. While Polis 1.0’s largest deployment reached 33,547 participants (a conversation hosted by Germany’s *Aufstehen* party), Polis 2.0’s infrastructure enables 10–30x increases, supporting millions of simultaneous participants.  
* **Dynamic Opinion Mapping:** The Polis algorithm analyzes how groups participants naturally cluster together clu7ster based on the similarity of the statements they submit and of how they vote on others' statements, dynamically adjusting clustering opinions clusters refreshing those clusters as the conversation evolves to maintain coherent analysis across hundreds of thousands of statements and millions of votes.  
* **Semantic Topic Clustering:** Polis 2.0 is the first to use the Embedding Vector Oriented Clustering (EVōC) library from the Tutte Institute for Mathematics and Computing to automatically organize conversations into evolving topic hierarchies—hundreds of topics and subtopics—derived from both organizer-seeded comments and participant input. Participants can view all topic areas and select those of greatest interest before entering the discussion. This organic process enables participants to collectively shape the agenda over time, with "hot" and "cold" areas of discussion naturally emerging, allowing Polis 2.0 conversations to remain open indefinitely.  
* **End-to-End Automation:** Earlier Polis conversations required labor-intensive moderation of participant input and facilitator expertise to distill dense outputs into actionable reports—processes that depended on extensive training and practice. Polis 2.0 automates conversation seeding, moderation (including toxicity filtering), semantic clustering, and report generation, removing the expert facilitator bottleneck while preserving the option for human oversight.

### **How Polis 2.0 works**

### 1\. Setting up a Polis 2.0 conversation

Polis is “seeded” with a set of statements that participants can “agree,” “disagree,” or “pass” on.

**Polis 2.0 allows for a number of input types:**

* **Short statements** (1-3 sentences): This is the primary format, optimized for mobile voting. Most of these statements are generated directly by participants.   
* **Long narratives**: Information in this format can be automatically chunked into discrete, votable statements using LLM processing  
* **Workshop transcripts**: Face-to-face discussion outputs converted to structured statements  
* **Social media posts**: Text from Facebook posts, Instagram, YouTube etc. processed and de-duplicated  
* **Online media comments**: News article comments compiled and filtered  
* **Email submissions**: Text-based input from non-digital participants  
* **Voice recordings**: Transcribed and processed into text statements

### 2\. Inviting Participants

Polis 2.0 includes multiple systems for managing participant identity and growth:

* **Invite Trees**: A structured invitation system tracks how participants join conversations, enabling organic growth through networks while maintaining quality. This snowball sampling approach allows organizers to understand how conversations spread and optimize for meaningful participation over viral reach.  
* **Identity Management**: Advanced XID (external identifier) whitelist and download capabilities, plus OIDC authentication providers, ensure secure and flexible participant access.  
* **Data Portability**: Complete data portability with XID support enables cross-platform participant tracking and analysis, compatible with popular polling and survey platforms such as SurveyMonkey, Qualtrics, Typeform, and Google Forms.

### 3\. Participating on Polis 2.0 

On Polis 2.0 participants can: 

* **Select topics of interest**—collectively setting the agenda for what everyone will vote on  
* **Vote on others’ statements**—agree, disagree, or pass (there’s no reply function, by design)  
* **Submit statements about issues that matter to them**—shaping conversation topics  
* **Mark which statements are especially important to them**

\[SCREENSHOT OF BG2050 CONVERSATION\]

**Multi-lingual capabilities:** The system detects a participant’s browser language and automatically translates the UI text and statements into their preferred language. Participants can submit statements in any language and view all statements both in the default language and in their chosen language.

\[SCREENSHOT OF BG CONVERSATION IN A LANGUAGE OTHER THAN ENGLISH\]

### 4\. Moderating Polis 2.0

Polis conversations with tens of thousands of participant-entered statements require effective moderation. Polis 2.0 includes AI-assisted moderation features to support this:

* **Toxicity Detection:** Real-time flagging of hate speech, harassment, and extremist content  
* **Duplicate Prevention:** Semantic similarity analysis reduces spam and repetition  
* **Language Processing:** Automatic translation for multilingual participation

Human Oversight (recommended):

* **Review:** Human review of AI moderation decisions  
* **Cultural Sensitivity:** Specialized review for marginalized or under-represented community contributions  
* **Expert Fact-checking:** Specialists verify claims about technical details  
* **Company and Community Standards:** Transparent moderation guidelines co-developed with participant input

In addition, the statement routing system functions as a form of moderation by determining the optimal presentation of statements to each participant.

### 5\. Real-time Analysis & Visualization

**Polis 2.0 Outputs**

* **Comprehensive Topic and Opinion Mapping:** Polis 2.0 maps the conversation by identifying popular topics, subtopics and their interconnections, areas of consensus, and points of disagreement. 

\[INTERACTIVE OF TOPIC MAP OF BG\]

* **Consensus Statements:** For each topic and subtopic, the platform generates collective statements that reflect agreement across all groups, supported by the underlying comments and votes. These statements represent authentic consensus rather than imposed compromise.

\[BG COLLECTIVE STATEMENTS PANEL\]

\[TOPIC STATS – THE BEESWARM VIEW\]

* **Automated Narrative Report Generation:** Polis 2.0 generates automated narrative reports and can draw on multiple LLM models. Reports cover the entire conversation or focus on specific topics and subtopics. The platform employs statistical grounding, prompt engineering, and evaluations to ensure high-quality summaries, with each clause in the report including citations for easy human verification.

\[BG NARRATIVE REPORT WITH CITATIONS — MAKE SURE THERE ARE NO HALLUCINATIONS\!\!\]

* **Data Repository:** All data remains accessible for ongoing reference and further analysis 

\[SCREENSHOT OF RAW DATA LINKS??\]
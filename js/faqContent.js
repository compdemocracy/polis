var faqContent = [
{
	title:"What is pol.is?",
	content: "Polis is a tool for gathering open ended feedback from an audience of any size. We built pol.is for city scale conversations - thousands, hundreds of thousands and millions. For the visualization to hit its stride, you need around 12 people."
},
{
	title:"What are the use cases for pol.is?",
	content: "The problem of getting lots of people to communicate effectively is perennial, and so are the use cases for the tool. The problem of having a large physical audience in front of you shows up in college classrooms, at political town halls, at professional conferences, at company meetings, etc. Online, it’s something that surveys have traditionally been used for, but we have a different philosophy than surveys ([[see below]]). Comment threads that scroll down endlessly"
},
{
	title:"How do I get started?",
	content: "First, [[create an account here]], which will start you off with 5 free conversations so that you can evaluate the tool. The best way to get started is to send a ‘play’ conversation around to 10 or more people. Add a topic and description - if you need a test conversation, ask an arbitrarily large group “How’s it going?”, and you will inevitably have enough variance and humor to make the visualization interesting. Share the link with your audience. Those who have the link will be able to join the conversation."
},
{
	title:"How many people do I need to have a successful conversation?",
	content: "Pol.is is not meant for small groups of 2-7 people. At those scales, email still holds up just fine. Pol.is really gets its wings when you are trying to organize the opinions of 10’s, 100’s, or 1000’s. The more participants, the better."
},
{
	title:"How does pol.is work?",
	content: "When you share the link with participants, they are able to join the conversation and submit their ideas, as well as vote on the other ideas being submitted by other users. Each participant sees his dot move around the visualization in response to his vote, and can click on the visualization"
},
{
	title:"Ok yeah but how does pol.is work? ",
	content: "Statistics"
},
{
	title:"You’re being evasive and I’m technical. Give me the goods.",
	content: "PCA & clustering… the visualization is a projection first two principal components. [[Check out this deck]] if you’re a data scientist and you want to know the full story, search the faq for the tag ‘technical’ and check out all the [[cool things we’re going to let you do with your data]] in the admin dash."
},
{
	title:"Where can I use pol.is?",
	content: "There are many formats that pol.is is suitible for. Consider a comment board …"
},
{
	title:"What kind of patterns will pol.is find in my data?",
	content: "Polis "
},
{
	title:"What does the visualization mean? ",
	content: "It groups together users who voted similarly. "
},
{
	title:"Do all participants see the visualization?",
	content: "Yes, psychology of finding a place, voting more, etc"
},
{
	title:"How is pol.is different from surveys?",
	content: "Bias Smushing users together vs keeping them apart No questions or answers to create auto correlation with existing data"
},
{
	title:"How do I use the pol.is API?",
	content: "There are a bunch of ways you can use "
},
{
	title:"Can I integrate pol.is into an existing application?",
	content: "Yes, quickly and easily, using the API. If you’re interested in building with pol.is as an engine, you’ll find that we’re very excited to talk to you. [[Ping us]]. "
},
{
	title:"How much does pol.is cost?",
	content: "That depends on what you need. For individuals who just need to be able to start conversations one at a time, and have no need for the advanced analytics tools, it’s $100/month. For sites where"
},
{
	title:"I’m concerned about data security. Do I have options?",
	content: "Maximum data security is the only option. To use the metadata features of the API, you can upload your data to google BigQuery. That means you have complete control over your data and, more importantly, our servers have no access to it. You type in your db access key in the browser, and we don’t cache your key. We’ll run queries on BigQuery and populate the analytics dash through your browser, and you can rest assured your data is known only to your people. None of our math requires that you house your data on our servers. We think this is a model for all analytics engines moving forward. Why shouldn’t you be in complete control of your data? "
},
{
	title:"What are the advanced features available in the analytics dash?",
	content: "There are two main views - Summary and Explore. Summary is pol.is surfacing interesting information for you, correlating sentiment groups against data you already have. Looks like everyone who agreed with x (in pol.is) also happened to y and z (in your behavioral data, account information, metadata, etc). Explore is you digging into your data and finding exactly what you want, using [[crossfiltering]]. You can recompute the visualization with certain comments ommitted, or increase the number of groups, create cohorts and export them."
},
{
	title:"Can you give me some ",
	content: ""
},
{
	title:"I’d like to use pol.is for x & y, but there’s a feature I would need… ",
	content: "If you would like to submit a feature request, [[head here]]. Truth in advertising, we prioritize those features requested by customers on the org plan that we find most generalizable."
},
{
	title:"What are planned upcoming features?",
	content: "[[must keep up to date]] moderation"
}

];

module.exports = faqContent;
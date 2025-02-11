import React from "react";

const Narrative = ({ sectionData, model }) => {
  if (!sectionData) return null;

  if (sectionData.errors) return (
    <p>Not enough data has been provided for analysis, please check back later</p>
  )

  const txt =
      sectionData?.model === "claude" ? sectionData?.modelResponse?.content[0]?.text : sectionData?.modelResponse;

    const respData = sectionData?.model === "claude" ? JSON.parse(`{${txt}`) : JSON.parse(txt);

  return (
    <article style={{ maxWidth: "600px" }}>
      {respData?.paragraphs?.map((section) => (
        <div key={section.id}>
          <h5>{section.title}</h5>

          {section.sentences.map((sentence, idx) => (
            <p key={idx}>
              {sentence.clauses.map((clause, cIdx) => (
                <span key={cIdx}>
                  {clause.text}
                  {clause.citations.map((citation, citIdx) => (
                    <sup key={citIdx}>
                      {citation}
                      {citIdx < clause.citations.length - 1 ? ", " : ""}
                    </sup>
                  ))}
                  {cIdx < sentence.clauses.length - 1 ? " " : ""}
                </span>
              ))}
            </p>
          ))}
        </div>
      ))}
    </article>
  );
};

export default Narrative;

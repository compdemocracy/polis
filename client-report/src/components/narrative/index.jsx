import React from "react";

const Narrative = ({ sectionData, model }) => {
  if (!sectionData) return null;

  const txt = model === "claude" ? sectionData.responseClaude.content[0].text : sectionData.responseGemini;

  const respData = model === "claude" ? JSON.parse(`{${txt}`) : JSON.parse(txt);

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

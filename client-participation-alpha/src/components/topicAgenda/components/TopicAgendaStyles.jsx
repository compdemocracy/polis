import React from "react";

const TopicAgendaStyles = () => (
  <style>{`
    .topic-agenda {
      margin-top: 2rem;
      padding: 1rem;
      background-color: #f8f9fa;
      border-radius: 8px;
    }
    
    .topic-agenda-widget {
      width: 100%;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .current-layer {
      display: flex;
      flex-direction: column;
    }

    .layer-header {
      padding: 1.5rem;
      border-bottom: 1px solid #e9ecef;
      text-align: center;
    }

    .layer-header h1 {
      margin: 0 0 0.75rem 0;
      color: #333;
      font-size: 1.5rem;
      font-weight: 600;
    }

    .call-to-action {
      color: #666;
      font-size: 0.95rem;
      line-height: 1.5;
      max-width: 600px;
      margin: 0 auto;
    }

    .done-button-container {
      padding: 1rem 1.5rem;
      border-top: 1px solid #e9ecef;
      background: white;
    }
    
    .done-button {
      width: 100%;
      padding: 0.75rem 1.5rem;
      background: #03a9f4;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    
    .done-button:hover {
      background: #0288d1;
    }
    
    .done-button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .topics-scroll-container {
      max-height: 400px;
      overflow-y: auto;
      padding: 1rem;
    }
    
    .topics-grid {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .topic-item {
      background: white;
      border: 2px solid #e9ecef;
      border-radius: 8px;
      padding: 0.5rem 1rem;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
    }

    .topic-item:hover {
      border-color: #03a9f4;
      transform: translateY(-1px);
    }

    .topic-item.selected {
      border-color: #03a9f4;
      background: #e3f2fd;
    }

    .topic-content {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .topic-text {
      color: #212529;
      font-size: 0.95rem;
      line-height: 1.4;
    }
    
    .topic-checkmark {
      flex-shrink: 0;
      margin-left: auto;
    }

    .loading, .error-message {
      text-align: center;
      padding: 2rem;
    }

    .error-message {
      color: #dc3545;
    }

    .layer-divider {
      width: 100%;
      margin: 1rem 0 0.5rem 0;
      padding: 0.5rem;
      background: #f8f9fa;
      border-radius: 4px;
      text-align: center;
      font-size: 0.85rem;
      color: #6c757d;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  `}</style>
);

export default TopicAgendaStyles;
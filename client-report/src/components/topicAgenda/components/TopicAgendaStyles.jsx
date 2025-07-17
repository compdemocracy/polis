import React from "react";

const TopicAgendaStyles = () => (
  <style>{`
    .topic-agenda {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: #f5f5f5;
    }
    
    .topic-agenda-widget {
      width: 90%;
      max-width: 360px;
      height: 600px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    /* Desktop: double width */
    @media (min-width: 768px) {
      .topic-agenda-widget {
        max-width: 720px;
      }
    }



    .current-layer {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .layer-header {
      padding: 16px;
      border-bottom: 1px solid #e9ecef;
      flex-shrink: 0;
    }

    .step-section {
      margin-bottom: 15px;
    }

    .progress-bar-inline {
      display: inline-block;
      width: 80px;
      height: 6px;
      background: #e9ecef;
      border-radius: 3px;
      overflow: hidden;
      margin-left: 10px;
      vertical-align: middle;
    }

    .call-to-action {
      color: #666;
      font-size: 0.9rem;
      margin: 0 0 12px 0;
      line-height: 1.4;
      text-align: center;
    }

    .selection-status {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 15px;
      font-weight: 500;
    }

    .layer-header h1 {
      margin: 0 0 8px 0;
      color: #333;
      font-size: 1.25rem;
      font-weight: 600;
      text-align: center;
    }

    .layer-header h2 {
      margin: 0 0 8px 0;
      color: #333;
      font-size: 1.2rem;
    }

    .layer-subtitle {
      color: #666;
      font-size: 0.95rem;
      margin-bottom: 15px;
    }

    .done-button-container {
      padding: 12px 16px;
      border-top: 1px solid #e9ecef;
      background: white;
    }
    
    .done-button {
      width: 100%;
      padding: 14px;
      background: #03a9f4;
      color: white;
      border: none;
      border-radius: 12px;
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

    .step-and-button {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .step-and-button h2 {
      margin: 0;
    }

    .selection-count {
      font-weight: 300;
      font-style: italic;
    }

    .action-buttons {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .bank-button, .submit-finish-button {
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 1rem;
    }

    .bank-button {
      background: #03a9f4;
      color: white;
    }

    .bank-button:hover:not(.disabled) {
      background: #0288d1;
    }

    .bank-button.disabled {
      background: #bbb;
      cursor: not-allowed;
      opacity: 0.6;
    }

    .submit-finish-button {
      background: #28a745;
      color: white;
    }

    .submit-finish-button:hover:not(.disabled) {
      background: #218838;
    }

    .submit-finish-button.disabled {
      background: #bbb;
      cursor: not-allowed;
      opacity: 0.6;
    }

    .topics-scroll-container {
      flex: 1;
      overflow-y: scroll; /* Always show scrollbar */
      padding: 12px;
      -webkit-overflow-scrolling: touch;
    }
    
    /* Always show scrollbar on webkit browsers */
    .topics-scroll-container::-webkit-scrollbar {
      width: 8px;
      background-color: transparent;
    }
    
    .topics-scroll-container::-webkit-scrollbar-track {
      background-color: #f1f1f1;
      border-radius: 4px;
    }
    
    .topics-scroll-container::-webkit-scrollbar-thumb {
      background-color: #c1c1c1;
      border-radius: 4px;
    }
    
    .topics-scroll-container::-webkit-scrollbar-thumb:hover {
      background-color: #a8a8a8;
    }
    
    .topics-grid {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
    }

    .topic-item {
      background: white;
      border: 2px solid #e9ecef;
      border-radius: 12px;
      padding: 10px 14px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      max-width: 100%;
    }

    .topic-item:hover {
      border-color: #03a9f4;
      box-shadow: 0 3px 8px rgba(3, 169, 244, 0.15);
      transform: translateY(-1px);
    }

    .topic-item:active {
      transform: translateY(0);
    }

    .topic-item.selected.brick {
      border-color: #03a9f4;
      background: #e3f2fd;
      box-shadow: inset 0 0 0 1px #03a9f4;
    }

    .topic-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .topic-id {
      color: #6c757d;
      font-size: 0.8rem;
      font-weight: 600;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    }


    .source-indicator {
      margin-left: 5px;
      font-size: 0.8rem;
    }


    .topic-text {
      color: #212529;
      font-size: 1.05rem;
      line-height: 1.4;
      font-weight: 500;
    }
    
    .topic-checkmark {
      flex-shrink: 0;
      margin-left: auto;
    }

    .no-data, .loading, .error-message {
      text-align: center;
      padding: 40px;
      background: white;
      border-radius: 8px;
      margin: 20px 0;
    }

    .error-message {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }

    .layer-divider {
      width: 100%;
      margin: 12px 0 8px 0;
      padding: 6px 10px;
      background: #f8f9fa;
      border-radius: 8px;
      text-align: center;
      font-size: 0.8rem;
      color: #6c757d;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* Special styling for SUPER SPECIFIC TOPICS */
    .topics-grid .layer-divider:nth-of-type(2) {
      background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
      color: #1976d2;
      font-weight: 700;
      animation: pulse-subtle 2s ease-in-out infinite;
    }
    
    @keyframes pulse-subtle {
      0%, 100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.9;
        transform: scale(0.98);
      }
    }
    
    /* Mobile responsiveness */
    @media (max-width: 480px) {
      .topic-agenda {
        padding: 0;
      }
      
      .topic-agenda-widget {
        max-width: 100%;
        height: 100vh;
        border-radius: 0;
      }
    }
  `}</style>
);

export default TopicAgendaStyles;

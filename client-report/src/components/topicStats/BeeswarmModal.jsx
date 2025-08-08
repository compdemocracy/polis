import React, { useEffect } from 'react';
import TopicBeeswarm from './visualizations/TopicBeeswarm.jsx';

const BeeswarmModal = ({ 
  isOpen, 
  onClose, 
  topicName, 
  topicKey, 
  topicStats,
  comments,
  math,
  conversation,
  ptptCount,
  formatTid,
  voteColors
}) => {

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);


  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}
    onClick={onClose}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        maxWidth: '90vw',
        maxHeight: '90vh',
        width: '1200px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
      onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          padding: '20px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0 }}>{topicName}</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              padding: '5px'
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          {/* Beeswarm Visualization */}
          <div style={{ width: '100%' }}>
            <h3 style={{ marginTop: 0, textAlign: 'center' }}>Group-Aware Consensus Distribution</h3>
            <p style={{ fontSize: '14px', color: '#666', marginBottom: '20px', textAlign: 'center' }}>
              Each circle represents a comment. Position shows how similarly groups voted. 
              Hover to see the group vote breakdown.
            </p>
            <TopicBeeswarm
              comments={comments}
              commentTids={topicStats?.comment_tids || []}
              math={math}
              conversation={conversation}
              ptptCount={ptptCount}
              formatTid={formatTid}
              voteColors={voteColors}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default BeeswarmModal;
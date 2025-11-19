import { useState, useEffect, useRef, useCallback } from 'react';
import PCAVisualization from './PCAVisualization';
import { fetchPCAData, type PCAData } from '../api/pca';
import { fetchComments, type Comment } from '../api/comments';

const REFRESH_DELAY_MS = 1000;

interface VisualizationContainerProps {
  conversation_id: string;
}

export default function VisualizationContainer({ conversation_id }: VisualizationContainerProps) {
  const [pcaData, setPcaData] = useState<PCAData | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentMathTick = useRef<number | undefined>(undefined);
  const refetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const loadData = useCallback(async (showLoadingState = true) => {
    if (!conversation_id) {
      setLoading(false);
      setError('No conversation ID provided');
      return;
    }

    try {
      if (showLoadingState) {
        setLoading(true);
      }
      setError(null);
      
      // Fetch both PCA data and comments in parallel
      const [pcaDataResult, commentsResult] = await Promise.all([
        fetchPCAData(conversation_id),
        fetchComments(conversation_id),
      ]);
      
      // Check if mathTick has changed (skip update if unchanged)
      if (pcaDataResult.mathTick !== undefined && 
          pcaDataResult.mathTick === currentMathTick.current) {
        // Math hasn't been recalculated yet, data is the same
        return;
      }
      
      currentMathTick.current = pcaDataResult.mathTick;
      setPcaData(pcaDataResult);
      setComments(commentsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      console.error('Error fetching data:', err);
    } finally {
      if (showLoadingState) {
        setLoading(false);
      }
    }
  }, [conversation_id]);

  // Initial load
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for vote/comment submissions and refetch after delay
  useEffect(() => {
    const handleDataChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.conversation_id === conversation_id) {
        // Clear any pending refetch
        if (refetchTimeoutRef.current) {
          clearTimeout(refetchTimeoutRef.current);
        }
        
        // Schedule refetch after 1 second delay
        refetchTimeoutRef.current = setTimeout(() => {
          loadData(false); // Don't show loading state for updates
        }, REFRESH_DELAY_MS);
      }
    };

    window.addEventListener('polis-vote-submitted', handleDataChange);
    window.addEventListener('polis-comment-submitted', handleDataChange);
    
    return () => {
      window.removeEventListener('polis-vote-submitted', handleDataChange);
      window.removeEventListener('polis-comment-submitted', handleDataChange);
      if (refetchTimeoutRef.current) {
        clearTimeout(refetchTimeoutRef.current);
      }
    };
  }, [conversation_id, loadData]);

  if (loading) {
    return (
      <section className="section-card loading-state" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>Loading visualization data...</p>
      </section>
    );
  }

  if (error) {
    return (
       <section className="section-card" style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
          <p>Visualization unavailable</p>
       </section>
    );
  }

  if (!pcaData) {
    return null;
  }

  return (
    <div className="visualization-container">
      <PCAVisualization data={pcaData} comments={comments} conversationId={conversation_id} />
    </div>
  );
}


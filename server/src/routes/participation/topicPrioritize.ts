import { Request, Response } from "express";
import { getZidFromConversationId } from "../../conversation";
import logger from "../../utils/logger";
import { queryP } from "../../db/pg-query";

/**
 * Lightweight endpoint for the participation interface to check if topic prioritization is available
 * 
 * This endpoint is designed specifically for client-participation-alpha to determine
 * if a conversation has report and Delphi data available for the topic prioritization feature.
 * 
 * Public endpoint - no authentication required
 */
export async function handle_GET_participation_topicPrioritize(req: Request, res: Response) {
  const { conversation_id } = req.query;
  
  if (!conversation_id) {
    return res.status(400).json({
      status: "error",
      message: "conversation_id is required"
    });
  }

  try {
    // Get the numeric zid from the zinvite
    const zid = await getZidFromConversationId(conversation_id as string);
    
    if (!zid) {
      return res.status(404).json({
        status: "error", 
        message: "Conversation not found",
        has_report: false,
        has_delphi_data: false
      });
    }

    // Check if there's a report for this conversation
    const reportQuery = "SELECT report_id, created FROM reports WHERE zid = $1 ORDER BY created DESC LIMIT 1";
    const reportResult = await queryP(reportQuery, [zid]) as any[];
    
    if (!reportResult || reportResult.length === 0) {
      return res.json({
        status: "success",
        conversation_id: zid,
        has_report: false,
        has_delphi_data: false,
        message: "No report available for this conversation"
      });
    }

    const report = reportResult[0];
    
    // For now, we'll assume if there's a report, there might be Delphi data
    // In the future, we could check DynamoDB for actual Delphi data existence
    return res.json({
      status: "success",
      conversation_id: zid,
      report_id: report.report_id,
      has_report: true,
      has_delphi_data: true, // Optimistic - the client will verify when fetching
      report_created: report.created
    });

  } catch (error) {
    logger.error("Error in topicPrioritize endpoint:", error);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      has_report: false,
      has_delphi_data: false
    });
  }
}
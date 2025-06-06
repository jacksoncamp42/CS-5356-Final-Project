import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { z } from "zod";
import pkg from 'pg';
const { Client } = pkg;

const createBoardSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  userId: z.union([z.string(), z.number().int().positive()]), // Accept both string and number IDs
});

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }
    
    const body = await req.json();
    
    // Validate input
    const result = createBoardSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { message: "Invalid input data", errors: result.error.errors },
        { status: 400 }
      );
    }
    
    const { name, description, userId } = result.data;
    
    // Verify that the user ID matches the session user
    // Convert both to strings for comparison to handle both string and number IDs
    const sessionUserId = session.user.id;
    const requestUserId = String(userId);
    
    console.log("Boards API: Comparing user IDs", { sessionUserId, requestUserId });
    
    if (requestUserId !== sessionUserId) {
      return NextResponse.json(
        { message: "Unauthorized: Cannot create board for another user" },
        { status: 403 }
      );
    }
    
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("Database connection string is missing");
    }
    
    console.log("Boards API: Connecting to database...");
    const client = new Client({ 
      connectionString,
      ssl: { rejectUnauthorized: false } // Important for Vercel deployment
    });
    await client.connect();
    console.log("Boards API: Connected to database successfully");
    
    let newBoard = null;
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Insert the board
      const boardResult = await client.query(
        'INSERT INTO boards (name, description, user_id) VALUES ($1, $2, $3) RETURNING *',
        [name, description, userId]
      );
      
      newBoard = boardResult.rows[0];
      
      // Create default columns (To Do, In Progress, Done)
      const defaultColumns = [
        { name: "To Do", position: 0, boardId: newBoard.id },
        { name: "In Progress", position: 1, boardId: newBoard.id },
        { name: "Done", position: 2, boardId: newBoard.id },
      ];
      
      for (const col of defaultColumns) {
        await client.query(
          'INSERT INTO columns (name, position, board_id) VALUES ($1, $2, $3)',
          [col.name, col.position, col.boardId]
        );
      }
      
      // Commit transaction
      await client.query('COMMIT');
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
    
    return NextResponse.json(
      { message: "Board created successfully", board: newBoard },
      { status: 201 }
    );
  } catch (error) {
    console.error("Board creation error:", error);
    return NextResponse.json(
      { message: "Something went wrong", error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
} 
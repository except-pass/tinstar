"use client";

import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface DeleteSessionDialogProps {
  sessionId: string;
  sessionTitle: string;
  onDelete: (sessionId: string) => Promise<void>;
  className?: string;
}

export function DeleteSessionDialog({
  sessionId,
  sessionTitle,
  onDelete,
  className,
}: DeleteSessionDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    try {
      setIsDeleting(true);
      await onDelete(sessionId);
      setIsOpen(false);
    } catch (error) {
      console.error("Failed to delete session:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`p-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10 z-10 ${className}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Trash2Icon className="h-3 w-3" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Delete Session</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{sessionTitle}"? This will move the
            session file to your .tinstar folder for recovery.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-muted-foreground">
            The session will be moved to ~/.tinstar/projects/ and can be restored
            by moving the file back to ~/.claude/projects/
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setIsOpen(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete Session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
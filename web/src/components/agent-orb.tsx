import { cn } from "@/lib/utils"

/** The agent's face: a soft, slowly turning gradient orb that breathes faster while the agent works. */
export function AgentOrb({ size = 32, active = false, className }: { size?: number; active?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,#8b5cf6,#ec4899,#f59e0b,#10b981,#3b82f6,#8b5cf6)] blur-[1px]",
          active ? "animate-[spin_1.6s_linear_infinite]" : "animate-[spin_9s_linear_infinite]",
        )}
      />
      <span className="absolute inset-[12%] rounded-full bg-background/35 backdrop-blur-sm" />
      <span
        className={cn(
          "absolute inset-[28%] rounded-full bg-white/80 blur-[2px] dark:bg-white/60",
          active ? "animate-[pulse_1s_ease-in-out_infinite]" : "animate-[pulse_3.5s_ease-in-out_infinite]",
        )}
      />
    </span>
  )
}

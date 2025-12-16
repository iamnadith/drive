"use client"

import * as React from "react"
import { Activity, CheckCircle2, AlertCircle, Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

export default function MigrationsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <h2 className="text-2xl font-bold tracking-tight">Migrations</h2>
      
      <div className="grid gap-4">
        <Card>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Active Job: #MIG-2024-009</CardTitle>
                    <Badge className="bg-blue-500">In Progress</Badge>
                </div>
                <CardDescription>Migrating <strong>R2-Old-03</strong> to <strong>R2-Prod-01</strong></CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span>Progress</span>
                            <span className="font-medium">64%</span>
                        </div>
                        <Progress value={64} className="h-2" />
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                         <div>
                            <p className="text-muted-foreground">Total Objects</p>
                            <p className="font-medium">1.2M</p>
                         </div>
                         <div>
                            <p className="text-muted-foreground">Transferred</p>
                            <p className="font-medium">768K</p>
                         </div>
                         <div>
                            <p className="text-muted-foreground">Est. Time Remaining</p>
                            <p className="font-medium">2h 15m</p>
                         </div>
                    </div>
                </div>
            </CardContent>
        </Card>

        <h3 className="text-lg font-semibold mt-4">History</h3>
        
        <div className="space-y-4">
            {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border p-4 bg-card text-card-foreground">
                     <div className="flex items-center gap-4">
                         <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-500/10">
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                         </div>
                         <div>
                             <p className="font-medium text-sm">Migration #MIG-2024-00{8-i}</p>
                             <p className="text-xs text-muted-foreground">Completed on Apr {8-i}, 2024</p>
                         </div>
                     </div>
                     <div className="flex items-center gap-8 text-sm hidden md:flex">
                        <div>
                            <span className="text-muted-foreground mr-2">Source:</span>
                            R2-Legacy-0{i}
                        </div>
                         <div>
                            <span className="text-muted-foreground mr-2">Target:</span>
                            R2-Prod-01
                        </div>
                        <div>
                            <span className="text-muted-foreground mr-2">Size:</span>
                            {4.5 + i} TB
                        </div>
                     </div>
                     <Button variant="ghost" size="sm">Details</Button>
                </div>
            ))}
             <div className="flex items-center justify-between rounded-lg border p-4 bg-card text-card-foreground">
                     <div className="flex items-center gap-4">
                         <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500/10">
                            <AlertCircle className="h-5 w-5 text-red-500" />
                         </div>
                         <div>
                             <p className="font-medium text-sm">Migration #MIG-2024-004</p>
                             <p className="text-xs text-muted-foreground">Failed on Mar 25, 2024</p>
                         </div>
                     </div>
                     <div className="flex items-center gap-8 text-sm hidden md:flex">
                        <div>
                            <span className="text-muted-foreground mr-2">Source:</span>
                            R2-Legacy-04
                        </div>
                         <div>
                            <span className="text-muted-foreground mr-2">Target:</span>
                            R2-Prod-01
                        </div>
                        <div>
                            <span className="text-muted-foreground mr-2">Error:</span>
                            Rate Limit Exceeded
                        </div>
                     </div>
                     <Button variant="ghost" size="sm">Retry</Button>
                </div>
        </div>
      </div>
    </div>
  )
}


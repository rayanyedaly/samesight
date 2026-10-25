
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "Finding": {
                  Row: {
                    "body": string,"createdAt": string,"createdBy": string,"id": string,"inspectionId": string,"seq": number,"severity": string,"supersedesId": string | null,"tenantId": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"createdAt"?: string,"createdBy"?: string,"id": string,"inspectionId": string,"seq"?: never,"severity": string,"supersedesId"?: string | null,"tenantId": string
                  }
                  Update: {
                    "body"?: string,"createdAt"?: string,"createdBy"?: string,"id"?: string,"inspectionId"?: string,"seq"?: never,"severity"?: string,"supersedesId"?: string | null,"tenantId"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "Finding_inspectionId_supersedesId_fkey"
      columns: ["inspectionId","supersedesId"]
isOneToOne: false
      referencedRelation: "Finding"
      referencedColumns: ["inspectionId","id"]
    },{
      foreignKeyName: "Finding_tenantId_fkey"
      columns: ["tenantId"]
isOneToOne: false
      referencedRelation: "Tenant"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "Finding_tenantId_inspectionId_fkey"
      columns: ["tenantId","inspectionId"]
isOneToOne: false
      referencedRelation: "Inspection"
      referencedColumns: ["tenantId","id"]
    }
                  ]
                },"Inspection": {
                  Row: {
                    "assigneeId": string | null,"createdAt": string,"id": string,"internalNotes": string | null,"siteId": string,"status": string,"tenantId": string,"title": string,"updatedAt": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigneeId"?: string | null,"createdAt"?: string,"id": string,"internalNotes"?: string | null,"siteId": string,"status"?: string,"tenantId": string,"title": string,"updatedAt"?: string
                  }
                  Update: {
                    "assigneeId"?: string | null,"createdAt"?: string,"id"?: string,"internalNotes"?: string | null,"siteId"?: string,"status"?: string,"tenantId"?: string,"title"?: string,"updatedAt"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "Inspection_tenantId_fkey"
      columns: ["tenantId"]
isOneToOne: false
      referencedRelation: "Tenant"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "Inspection_tenantId_siteId_fkey"
      columns: ["tenantId","siteId"]
isOneToOne: false
      referencedRelation: "Site"
      referencedColumns: ["tenantId","id"]
    }
                  ]
                },"Membership": {
                  Row: {
                    "createdAt": string,"displayName": string,"id": string,"role": string,"tenantId": string,"userId": string
                  }
                  ComputedFields: never
                  Insert: {
                    "createdAt"?: string,"displayName": string,"id"?: string,"role": string,"tenantId": string,"userId": string
                  }
                  Update: {
                    "createdAt"?: string,"displayName"?: string,"id"?: string,"role"?: string,"tenantId"?: string,"userId"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "Membership_tenantId_fkey"
      columns: ["tenantId"]
isOneToOne: false
      referencedRelation: "Tenant"
      referencedColumns: ["id"]
    }
                  ]
                },"Photo": {
                  Row: {
                    "createdAt": string,"createdBy": string,"findingId": string | null,"id": string,"inspectionId": string,"sha256": string,"storagePath": string,"tenantId": string
                  }
                  ComputedFields: never
                  Insert: {
                    "createdAt"?: string,"createdBy"?: string,"findingId"?: string | null,"id": string,"inspectionId": string,"sha256": string,"storagePath": string,"tenantId": string
                  }
                  Update: {
                    "createdAt"?: string,"createdBy"?: string,"findingId"?: string | null,"id"?: string,"inspectionId"?: string,"sha256"?: string,"storagePath"?: string,"tenantId"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "Photo_inspectionId_findingId_fkey"
      columns: ["inspectionId","findingId"]
isOneToOne: false
      referencedRelation: "Finding"
      referencedColumns: ["inspectionId","id"]
    },{
      foreignKeyName: "Photo_tenantId_fkey"
      columns: ["tenantId"]
isOneToOne: false
      referencedRelation: "Tenant"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "Photo_tenantId_inspectionId_fkey"
      columns: ["tenantId","inspectionId"]
isOneToOne: false
      referencedRelation: "Inspection"
      referencedColumns: ["tenantId","id"]
    }
                  ]
                },"Site": {
                  Row: {
                    "address": string | null,"createdAt": string,"id": string,"name": string,"tenantId": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"createdAt"?: string,"id": string,"name": string,"tenantId": string
                  }
                  Update: {
                    "address"?: string | null,"createdAt"?: string,"id"?: string,"name"?: string,"tenantId"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "Site_tenantId_fkey"
      columns: ["tenantId"]
isOneToOne: false
      referencedRelation: "Tenant"
      referencedColumns: ["id"]
    }
                  ]
                },"Tenant": {
                  Row: {
                    "createdAt": string,"id": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "createdAt"?: string,"id": string,"name": string
                  }
                  Update: {
                    "createdAt"?: string,"id"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "apply_batch":
{ Args: { "ops": Json }; Returns: undefined
                           },
"record_rejection":
{ Args: { "rejections": Json }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const

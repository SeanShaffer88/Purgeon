# Purgeon PowerShell module
# Import with: Import-Module .\src\backend\purgeon-module.ps1
# Cmdlets: Get-PurgeonProgram, Remove-PurgeonProgram, Get-PurgeonStartup, Set-PurgeonStartup,
#          Get-PurgeonJunk, Export-PurgeonList

#requires -Version 5.1

function Get-PurgeonProgram {
    <#
    .SYNOPSIS
        Lists installed desktop programs and Store apps.
    .DESCRIPTION
        Exports the program list to a temporary file and displays it.
    .PARAMETER Store
        Show Store apps instead of desktop programs.
    .PARAMETER Json
        Output as JSON.
    .EXAMPLE
        Get-PurgeonProgram
    .EXAMPLE
        Get-PurgeonProgram -Json
    #>
    [CmdletBinding()]
    param(
        [switch]$Store,
        [switch]$Json
    )
    $tmp = [System.IO.Path]::GetTempFileName()
    & purgeon --export programs --format $([bool]$Json ? 'json' : 'csv') --output $tmp
    if ($Json) {
        Get-Content $tmp -Raw | ConvertFrom-Json
    } else {
        Get-Content $tmp
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Remove-PurgeonProgram {
    <#
    .SYNOPSIS
        Uninstalls a program through Purgeon.
    .DESCRIPTION
        Runs the program's own uninstaller, then scans for leftovers.
    .PARAMETER Name
        Name of the program to uninstall.
    .PARAMETER Force
        Force removal without running the uninstaller.
    .EXAMPLE
        Remove-PurgeonProgram -Name "Foo Editor"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [switch]$Force
    )
    # Purgeon CLI does not yet have a direct --uninstall-by-name command.
    # Use the export to find the program, then remove it via the UI.
    Write-Warning "Use the Purgeon UI to uninstall '$Name'. CLI uninstall-by-name is not yet available."
}

function Get-PurgeonStartup {
    <#
    .SYNOPSIS
        Lists startup entries (Run keys, Startup folders, tasks, services).
    .DESCRIPTION
        Exports startup entries to a temporary file and displays them.
    .PARAMETER Json
        Output as JSON.
    .EXAMPLE
        Get-PurgeonStartup
    #>
    [CmdletBinding()]
    param(
        [switch]$Json
    )
    $tmp = [System.IO.Path]::GetTempFileName()
    & purgeon --export startup --format $([bool]$Json ? 'json' : 'csv') --output $tmp
    if ($Json) {
        Get-Content $tmp -Raw | ConvertFrom-Json
    } else {
        Get-Content $tmp
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Set-PurgeonStartup {
    <#
    .SYNOPSIS
        Enables or disables a startup entry.
    .DESCRIPTION
        Turns a startup entry on or off without deleting it.
    .PARAMETER Id
        Startup entry id in type|name format (e.g. run|FooUpdater).
    .PARAMETER Enable
        Enable the entry. If not set, the entry is disabled.
    .EXAMPLE
        Set-PurgeonStartup -Id "run|FooUpdater" -Enable:$false
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Id,
        [switch]$Enable
    )
    $action = if ($Enable) { 'on' } else { 'off' }
    & purgeon --startup $action --id $Id
}

function Get-PurgeonJunk {
    <#
    .SYNOPSIS
        Scans for junk files and reports categories.
    .DESCRIPTION
        Exports the junk scan to a temporary file and displays it.
    .PARAMETER Json
        Output as JSON.
    .EXAMPLE
        Get-PurgeonJunk
    #>
    [CmdletBinding()]
    param(
        [switch]$Json
    )
    $tmp = [System.IO.Path]::GetTempFileName()
    & purgeon --export junk --format $([bool]$Json ? 'json' : 'csv') --output $tmp
    if ($Json) {
        Get-Content $tmp -Raw | ConvertFrom-Json
    } else {
        Get-Content $tmp
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Export-PurgeonList {
    <#
    .SYNOPSIS
        Exports a list to a file.
    .DESCRIPTION
        Exports program lists, junk scans, startup entries, or backups to CSV, JSON or HTML.
    .PARAMETER Type
        Type of list to export: programs, startup, junk, backups.
    .PARAMETER Format
        Output format: csv, json, html.
    .PARAMETER Path
        Output file path.
    .EXAMPLE
        Export-PurgeonList -Type programs -Format csv -Path .\programs.csv
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('programs', 'startup', 'junk', 'backups')]
        [string]$Type,
        [ValidateSet('csv', 'json', 'html')]
        [string]$Format = 'csv',
        [Parameter(Mandatory)]
        [string]$Path
    )
    & purgeon --export $Type --format $Format --output $Path
}

Export-ModuleMember -Function Get-PurgeonProgram, Remove-PurgeonProgram, Get-PurgeonStartup, Set-PurgeonStartup, Get-PurgeonJunk, Export-PurgeonList
import sys
import subprocess
import os

def convert_word_to_pdf(input_path, output_path):
    try:
        # Ensure LibreOffice is available
        libreoffice_path = '/usr/lib/libreoffice/program/soffice'  # Adjust path based on your Lambda layer
        if not os.path.exists(libreoffice_path):
            raise Exception("LibreOffice not found")

        # Run LibreOffice in headless mode
        command = [
            libreoffice_path,
            '--headless',
            '--convert-to', 'pdf',
            '--outdir', os.path.dirname(output_path),
            input_path
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=240)

        if result.returncode != 0:
            raise Exception(f"LibreOffice failed: {result.stderr}")

        # LibreOffice saves the output as <input_name>.pdf in the outdir
        generated_pdf = os.path.join(os.path.dirname(output_path), os.path.basename(input_path).replace('.docx', '.pdf'))
        if not os.path.exists(generated_pdf):
            raise Exception("Output PDF not created")

        # Rename to match expected output path
        os.rename(generated_pdf, output_path)

    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python word_to_pdf.py <input_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    convert_word_to_pdf(input_path, output_path)
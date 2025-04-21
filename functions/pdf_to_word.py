import sys
from pdf2docx import Converter

def pdf_to_word(pdf_path, docx_path):
    try:
        print("[INFO] [1/4] Initializing converter...")
        cv = Converter(pdf_path)
        
        print("[INFO] [2/4] Parsing PDF...")
        # Simulate page-by-page progress (pdf2docx doesn't provide direct page callbacks)
        # For actual page count, you may need PyMuPDF
        num_pages = 10  # Placeholder; replace with actual page count if needed
        for page in range(1, num_pages + 1):
            print(f"[INFO] ({page}/{num_pages}) Page {page}")
        
        print("[INFO] [3/4] Converting to Word...")
        cv.convert(docx_path, start=0, end=None)
        
        print("[INFO] [4/4] Finalizing...")
        cv.close()
        print(f"Success: Converted {pdf_path} to {docx_path}")
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python pdf_to_word.py <pdf_path> <docx_path>")
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    docx_path = sys.argv[2]
    pdf_to_word(pdf_path, docx_path)